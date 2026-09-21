import { describe, expect, it } from 'vitest';
import { estimateSessionEnd as estimateDataset, FORECAST_POLICY, type ForecastObservation, type ForecastTarget } from './forecasts';
import { forecastFixture } from './forecast-fixtures';
import { opportunityKey, validateProposal } from '../validation';
import { templates as allocationTemplates } from '../templates/registry';
import { canonicalSerialize } from './values';

const estimateSessionEnd = (target: ForecastTarget, observations: readonly ForecastObservation[]) => estimateDataset(target, { observations, missing: [], rosterComplete: true });
const estimate = (f = forecastFixture()) => estimateSessionEnd(f.target, f.observations);
function mutate<T>(input: T, body: (copy: any) => void): T { const copy = structuredClone(input); body(copy); return copy; }
function missing(row: ForecastObservation): ForecastObservation {
  return { ...row, outcome: { ...row.outcome, completeness: 'incomplete', netPnlUsd: null, feesKnown: false, tradeStatus: 'unknown', fitExclusions: ['fees_unavailable'] } };
}
describe('empirical prospective session-end estimator', () => {
  it('computes an independently weighted known cohort including no-trade mass and returns only experimental outcome quantiles', async () => {
    const f = forecastFixture(), result = await estimate(f), p = f.observations[0].plan;
    expect(result.forecast).toMatchObject({ status: 'experimental', meanPnlCents: 100, medianPnlCents: 0,
      probabilityOfProfit: null, sampleCount: 30, capitalCents: f.target.plan.capital.ceilingCents,
      activationAt: f.target.plan.entryWindow.from, horizonEnd: f.target.plan.session.closeAt,
      quantiles: [{ probability: 0.1, pnlCents: -100 }, { probability: 0.5, pnlCents: 0 }, { probability: 0.9, pnlCents: 500 }] });
    expect(result.diagnostics.trainingDates).toBe(30); expect(result.diagnostics.calibrationDates).toBe(20);
    expect(result.diagnostics.noTradeWeight).toBeCloseTo(0.4); expect(result.diagnostics.calibration!.coverage).toBeCloseTo(1);
    const proposal = { ...p, ...f.target.plan, forecast: result.forecast };
    expect(() => validateProposal({ ...proposal, opportunityKey: opportunityKey(proposal) }, allocationTemplates)).not.toThrow();
  });
  it('is detached, deterministic under input permutation and does not mutate original observations', async () => {
    const f = forecastFixture(), before = canonicalSerialize(f), first = await estimate(f);
    expect(await estimateSessionEnd(f.target, [...f.observations].reverse())).toEqual(first);
    expect(canonicalSerialize(f)).toBe(before); 
  });
  it('calibrates the published outward-rounded cent range with sub-cent actual cash', async () => {
    const f = mutate(forecastFixture(), f => { for (const row of f.observations) {
      if (row.outcome.netPnlUsd === '-1') row.outcome.netPnlUsd = row.outcome.grossPnlUsd = '-1.001';
      if (row.outcome.netPnlUsd === '5') row.outcome.netPnlUsd = row.outcome.grossPnlUsd = '5.001';
    } });
    const result = await estimate(f); expect(result.forecast.status).toBe('experimental');
    expect(result.forecast.quantiles).toEqual([{ probability: 0.1, pnlCents: -101 }, { probability: 0.5, pnlCents: 0 }, { probability: 0.9, pnlCents: 501 }]);
    expect(result.diagnostics.calibration!.coverage).toBeCloseTo(1);
  });
  it('keeps unavailable metrics null in serialized output with no numeric fallback', async () => {
    const { forecast } = await estimateSessionEnd(forecastFixture().target, []);
    expect(forecast.status).toBe('unavailable');
    for (const key of ['meanPnlCents', 'medianPnlCents', 'quantiles', 'probabilityOfProfit']) expect(JSON.parse(JSON.stringify(forecast))[key]).toBeNull();
  });
  it('ignores future outcomes and revisions and never trains with a correction learned during calibration', async () => {
    const f = forecastFixture(), original = await estimate(f), row = f.observations[0];
    const future = mutate(row, r => { r.outcome.revision = 2; r.outcome.id += '-future'; r.outcome.netPnlUsd = '999';
      r.outcome.recordedAt = f.target.plan.session.closeAt; });
    const late = mutate(future, r => { r.outcome.recordedAt = f.observations[30].outcome.recordedAt; });
    expect(await estimateSessionEnd(f.target, [...f.observations, future, late])).toEqual(original);
  });
  it('does not treat repeated variants or symbols on the same dates as independent sessions', async () => {
    const f = forecastFixture();
    const clones = Array.from({ length: 5 }, (_, repeat) => f.observations.slice(0, 10).map(row => mutate(row, r => {
      r.candidate.id += `-variant-${repeat}`; r.outcome.id += `-variant-${repeat}`; r.outcome.candidateId = r.candidate.id;
      r.plan.id += `-variant-${repeat}`; r.candidate.proposal.id = r.plan.id;
      r.plan.symbol = `X${repeat}`; r.candidate.symbol = r.plan.symbol; r.candidate.source.symbols = [r.plan.symbol];
    }))).flat();
    const result = await estimateSessionEnd(f.target, clones);
    expect(result.diagnostics.trainingDates).toBe(10); expect(result.forecast.status).toBe('unavailable');
  });
  it('chooses the first offered variant independently of later attractive outcomes or completeness', async () => {
    const f = forecastFixture(), baseline = await estimate(f);
    const clones = f.observations.map(row => mutate(row, r => {
      r.candidate.id += '-later'; r.outcome.id += '-later'; r.outcome.candidateId = r.candidate.id;
      r.plan.id += '-later'; r.candidate.proposal.id = r.plan.id;
      r.outcome.netPnlUsd = '100'; r.outcome.grossPnlUsd = '100'; r.outcome.tradeStatus = 'traded';
    }));
    expect(await estimateSessionEnd(f.target, [...clones, ...f.observations])).toEqual(baseline);
    const incomplete = { ...f, observations: [missing(f.observations[0]), ...f.observations.slice(1), ...clones] };
    expect((await estimate(incomplete)).forecast.status).toBe('unavailable');
  });
  for (const change of ['capital', 'time', 'session', 'settings', 'costs', 'liquidity', 'risk', 'policy', 'template', 'exit', 'price', 'future_feature'] as const)
    it(`refuses unsupported ${change} context instead of scaling or borrowing another cohort`, async () => {
      const f = forecastFixture();
      const target = mutate(f.target, t => {
        if (change === 'capital') t.plan.capital.ceilingCents *= 2;
        if (change === 'time') t.plan.entryWindow.from = new Date(Date.parse(t.plan.entryWindow.from) + 60 * 60_000).toISOString();
        if (change === 'session') { t.plan.session.closeAt = t.plan.session.closeAt.replace('20:00:', '17:00:'); t.plan.intendedEnd = t.plan.intendedEnd.replace('19:55:', '16:55:'); }
        if (change === 'settings') t.plan.parameters.fastPeriod++;
        if (change === 'costs') t.costs.fees = 'A different explicit fee assumption';
        if (change === 'liquidity') t.features.dailyLiquidityUsd = 1000;
        if (change === 'risk') t.plan.risk.lossTriggerCents--;
        if (change === 'policy') t.plan.evidence.policy.version++;
        if (change === 'template') t.plan.template.version++;
        if (change === 'exit') t.plan.exitPolicy.version++;
        if (change === 'price') t.features.priceUsd *= 4;
        if (change === 'future_feature') t.features.asOf = t.plan.session.closeAt;
      });
      expect((await estimateSessionEnd(target, f.observations)).forecast.status).toBe('unavailable');
    });
  it('supports an early-close cohort only at its own observed horizon', async () => {
    const f = mutate(forecastFixture(), f => {
      for (const p of [f.target.plan, ...f.observations.map((r: any) => r.plan)]) {
        p.session.closeAt = p.session.closeAt.replace('20:00:', '17:00:'); p.intendedEnd = p.intendedEnd.replace('19:55:', '16:55:');
        p.entryWindow.to = p.entryWindow.to.replace('19:45:', '16:45:');
      }
      for (const r of f.observations) { r.candidate.session = r.plan.session; r.candidate.intendedEnd = r.plan.intendedEnd;
        r.candidate.features.minutesToClose -= 180; r.outcome.horizonEnd = r.plan.session.closeAt; }
    });
    expect((await estimate(f)).forecast).toMatchObject({ status: 'experimental', horizonEnd: f.target.plan.session.closeAt });
  });
  it('separates provenance and accounts and never pools simulated observations into a paper estimate', async () => {
    const f = forecastFixture(), paper: ForecastTarget = { ...f.target, provenance: 'paper_execution' };
    expect((await estimateSessionEnd(paper, f.observations)).forecast.status).toBe('unavailable');
    expect((await estimateSessionEnd({ ...f.target, scope: { ...f.target.scope, accountId: 'synthetic-other' } }, f.observations)).forecast.status).toBe('unavailable');
  });
  it('uses actual paper activation and excludes unsupported approval delay', async () => {
    const f = mutate(forecastFixture(), f => {
      f.target.provenance = 'paper_execution'; for (const row of f.observations) {
        row.outcome.provenance = 'paper_execution'; row.outcome.approvalId = 'synthetic-approval'; row.outcome.runId = row.plan.id;
        row.outcome.disposition = 'approved'; row.outcome.activationAt = new Date(Date.parse(row.candidate.offeredAt) + 5000).toISOString();
      }
    });
    expect((await estimate(f)).forecast.status).toBe('experimental');
    const delayed = mutate(f, f => { for (const r of f.observations) r.outcome.activationAt = new Date(Date.parse(r.candidate.offeredAt) + 60_000).toISOString(); });
    expect((await estimate(delayed)).forecast.status).toBe('unavailable');
  });
  it('retains a missing-fee exclusion and fails completeness instead of dropping a losing observation', async () => {
    const f = forecastFixture(); f.observations[0] = missing(f.observations[0]);
    const result = await estimate(f); expect(result.forecast.status).toBe('unavailable');
    expect(result.diagnostics.observations[0].exclusion).toBe('fees_unavailable');
    expect(result.diagnostics.reasons).toContain('incomplete_cohort');
  });
  it('disqualifies miscalibrated later outcomes without widening intervals or reranking', async () => {
    const f = mutate(forecastFixture(), f => { for (const r of f.observations.slice(30)) {
      r.outcome.netPnlUsd = '-20'; r.outcome.grossPnlUsd = '-20'; r.outcome.tradeStatus = 'traded';
    } });
    const result = await estimate(f); expect(result.forecast.status).toBe('unavailable');
    expect(result.diagnostics.reasons).toContain('failed_out_of_sample_calibration'); expect(result.diagnostics.calibration!.coverage).toBe(0);
  });
  it('rejects unstable training and unsupported predictive width', async () => {
    const f = mutate(forecastFixture(), f => { for (const r of f.observations.slice(15, 30)) {
      r.outcome.netPnlUsd = '1000'; r.outcome.grossPnlUsd = '1000'; r.outcome.tradeStatus = 'traded';
    } });
    const result = await estimate(f); expect(result.forecast.status).toBe('unavailable');
    expect(result.diagnostics.reasons).toContain('unstable_training_periods'); expect(result.diagnostics.reasons).toContain('unsupported_predictive_spread');
  });
  it('requires a complete roster and never silently drops an offered plan with no finalized outcome', async () => {
    const f = forecastFixture(), row = f.observations[0], missing = { candidate: row.candidate, plan: row.plan,
      provenance: row.outcome.provenance, activationAt: row.outcome.activationAt, costs: row.outcome.costs };
    const result = await estimateDataset(f.target, { observations: f.observations.slice(1), missing: [missing], rosterComplete: true });
    expect(result.forecast.status).toBe('unavailable'); expect(result.diagnostics.reasons).toContain('incomplete_cohort');
    expect(result.diagnostics.observations.find(r => r.candidateId === missing.candidate.id)).toMatchObject({ outcomeId: null, exclusion: 'missing_finalized_outcome' });
    expect((await estimateDataset(f.target, { observations: f.observations, missing: [], rosterComplete: false })).forecast.status).toBe('unavailable');
  });
  it('requires the retained original plan and respects the bounded dataset budget', async () => {
    const f = forecastFixture(), wrong = mutate(f.observations[0], r => { r.plan.parameters = { ...r.plan.parameters, fastPeriod: r.plan.parameters.fastPeriod + 1 }; });
    expect((await estimateSessionEnd(f.target, [wrong, ...f.observations.slice(1)])).forecast.status).toBe('unavailable');
    expect((await estimateSessionEnd(f.target, Array.from({ length: FORECAST_POLICY.maximumObservations + 1 }, () => f.observations[0]))).diagnostics.reasons.join(' ')).toContain('observation_budget');
  });
});
