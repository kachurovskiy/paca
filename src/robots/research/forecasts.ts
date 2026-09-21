import { canonicalSerialize, unavailableForecast } from './values';
import type { AccountScope } from '../../core/account';
import type { Forecast, RobotProposal } from '../domain';
import { instant, integer, requireValue } from '../../core/validation';
import { sameScope, validateScope } from '../validation';
import { validateSession } from '../plan';
import { executionProvenance } from '../outcome-facts';
import type { ProposalDraft } from './proposals';
import { validateOutcomeAssumptions, validateProspectiveCandidate, validateProspectiveOutcome,
  type OutcomeAssumptions, type ProspectiveCandidate, type ProspectiveOutcome } from './prospective-records';

import { FORECAST_POLICY } from './forecast-policy';
export { FORECAST_POLICY } from './forecast-policy';
export interface ForecastTarget {
  readonly scope: AccountScope;
  readonly plan: ProposalDraft;
  readonly provenance: ProspectiveOutcome['provenance'];
  readonly costs: OutcomeAssumptions;
  readonly features: Pick<ProspectiveCandidate['features'], 'asOf' | 'priceUsd' | 'dailyLiquidityUsd'>;
}
export interface ForecastObservation {
  readonly candidate: ProspectiveCandidate;
  readonly outcome: ProspectiveOutcome;
  /** Original immutable plan supplies execution, exit and risk bounds, not current UI settings. */
  readonly plan: RobotProposal;
}
export interface MissingForecastObservation {
  readonly candidate: ProspectiveCandidate; readonly plan: RobotProposal;
  readonly provenance: ProspectiveOutcome['provenance']; readonly activationAt: string; readonly costs: OutcomeAssumptions;
}
/** The roster must include unresolved/missing outcomes, not just successful finalizations. */
export interface ForecastDataset {
  readonly observations: readonly ForecastObservation[]; readonly missing: readonly MissingForecastObservation[];
  readonly rosterComplete: boolean;
}
interface Observation extends MissingForecastObservation { readonly outcome: ProspectiveOutcome | null; }
export interface ForecastDiagnostics {
  readonly id: string; readonly policy: typeof FORECAST_POLICY;
  readonly asOf: string; readonly provenance: ProspectiveOutcome['provenance'];
  readonly evidenceRef: string; readonly reasons: readonly string[];
  readonly cohortRef: string | null;
  readonly trainingWindow: { readonly from: string; readonly to: string };
  readonly calibrationWindow: { readonly from: string; readonly to: string };
  readonly trainingDates: number; readonly calibrationDates: number;
  readonly completeFraction: number | null; readonly noTradeWeight: number | null;
  readonly calibration: { readonly coverage: number; readonly lowerTail: number; readonly upperTail: number } | null;
  readonly observations: readonly { readonly candidateId: string; readonly outcomeId: string | null; readonly date: string;
    readonly partition: 'training' | 'calibration'; readonly weight: number; readonly exclusion: string | null }[];
  readonly limitations: readonly string[];
}
export interface ForecastReport { readonly forecast: Forecast; readonly diagnostics: ForecastDiagnostics; }
interface Row { observation: Observation; date: string; partition: 'training' | 'calibration'; exclusion: string | null; pnl: number | null; }
interface Weighted { row: Row; weight: number; pnl: number; }
const day = 86_400_000, policy = FORECAST_POLICY;
const check = (condition: unknown, code: string) => requireValue(condition, 'forecastEvidence', code);
const equal = (a: unknown, b: unknown) => canonicalSerialize(a) === canonicalSerialize(b);
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const duration = (plan: ProposalDraft) => Date.parse(plan.session.closeAt) - Date.parse(plan.session.openAt);
const offset = (plan: ProposalDraft, at: string) => Date.parse(plan.session.closeAt) - Date.parse(at);
const bucket = (value: number) => Math.floor(Math.log2(value));
const limitations = [
  'Experimental empirical cohort; fixed engineering gates do not establish predictive skill or validated evidence.',
  'Conditional on recorded prospective offers and supplied selection; not a validated full-universe selection pipeline.',
  'Equal independent-date weighting; an outcome quantile is a predictive range, not confidence in the mean.',
  'No capital scaling, stateful remaining-run estimate, profit-probability calibration or automatic model promotion.',
  'Closed-browser observation and unknown real fees remain unavailable; simulated fills never become actual execution.',
];

async function digest(value: unknown): Promise<string> {
  const data = new TextEncoder().encode(`robots-forecast-v1\n${canonicalSerialize(value)}`);
  const result = await crypto.subtle.digest('SHA-256', data);
  return `sha256-v1:${Array.from(new Uint8Array(result), b => b.toString(16).padStart(2, '0')).join('')}`;
}
function context(plan: ProposalDraft, features: ForecastTarget['features'], costs: OutcomeAssumptions, activation: string): string {
  validateSession(plan.session); instant(activation, 'activation'); instant(features.asOf, 'features.asOf');
  integer(plan.capital.ceilingCents, 'capital'); integer(plan.capital.equityCents, 'equity');
  integer(plan.risk.budgetCents, 'risk'); integer(plan.risk.lossTriggerCents, 'lossTrigger');
  check(features.priceUsd !== null && Number.isFinite(features.priceUsd) && features.priceUsd > 0
    && features.dailyLiquidityUsd !== null && Number.isFinite(features.dailyLiquidityUsd) && features.dailyLiquidityUsd > 0, 'missing_liquidity_context');
  check(plan.capital.ceilingCents / 100 / features.dailyLiquidityUsd! <= policy.maximumCapitalToDailyLiquidity, 'unsupported_liquidity_scaling');
  check(plan.capital.ceilingCents <= plan.capital.equityCents && plan.risk.budgetCents <= plan.capital.ceilingCents
    && plan.risk.lossTriggerCents <= plan.capital.ceilingCents, 'invalid_capital_context');
  check(plan.session.openAt <= activation && activation < plan.intendedEnd && plan.intendedEnd <= plan.session.closeAt, 'unsupported_horizon');
  check(Object.keys(plan.parameters).length > 0 && Object.keys(plan.parameters).length <= 20
    && Object.values(plan.parameters).every(Number.isFinite), 'invalid_parameters');
  validateOutcomeAssumptions(costs);
  return canonicalSerialize({ template: plan.template, researchPolicy: plan.evidence.policy, parameters: plan.parameters,
    execution: plan.executionPolicy, exit: plan.exitPolicy, risk: plan.risk, capitalCents: plan.capital.ceilingCents,
    calendar: plan.session.calendarId, timeZone: plan.session.timeZone, sessionLength: duration(plan),
    exitOffset: offset(plan, plan.intendedEnd), activationBucket: Math.ceil(offset(plan, activation) / (policy.activationBucketMinutes * 60_000)),
    priceBucket: bucket(features.priceUsd!), liquidityBucket: bucket(features.dailyLiquidityUsd!), costs });
}
function weighted(rows: readonly Row[]): Weighted[] {
  const counts = new Map<string, number>(); rows.forEach(row => counts.set(row.date, (counts.get(row.date) ?? 0) + 1));
  return rows.map(row => ({ row, pnl: row.pnl!, weight: 1 / counts.size / counts.get(row.date)! }));
}
const mean = (rows: readonly Weighted[]) => rows.reduce((sum, row) => sum + row.pnl * row.weight, 0);
function quantile(rows: readonly Weighted[], p: number): number {
  let cumulative = 0;
  const sorted = [...rows].sort((a, b) => a.pnl - b.pnl || compare(a.row.observation.candidate.id, b.row.observation.candidate.id));
  for (const row of sorted) { cumulative += row.weight; if (cumulative + 1e-12 >= p) return row.pnl; }
  return sorted.at(-1)!.pnl;
}

/** Pure bounded estimator. Caller supplies validated prospective repository facts; no I/O, ambient time or training fixtures. */
export async function estimateSessionEnd(targetInput: ForecastTarget, data: ForecastDataset): Promise<ForecastReport> {
  const target = structuredClone(targetInput), plan = target.plan, asOf = plan.generatedAt;
  validateScope(target.scope); instant(asOf, 'asOf'); instant(plan.validUntil, 'validUntil');
  const endDate = `${plan.session.tradingDate}T00:00:00.000Z`, cutoff = Date.parse(endDate) - policy.calibrationDays * day;
  const windows = { trainingWindow: { from: new Date(Date.parse(endDate) - policy.lookbackDays * day).toISOString(), to: new Date(cutoff).toISOString() },
    calibrationWindow: { from: new Date(cutoff).toISOString(), to: endDate } };
  const reasons: string[] = [], rows: Row[] = [];
  let cohort: string | null = null, completeFraction: number | null = null, noTradeWeight: number | null = null;
  let calibration: ForecastDiagnostics['calibration'] = null, trainingDates = 0, calibrationDates = 0;
  let estimates: { mean: number; median: number; low: number; high: number } | null = null;
  try {
    check(data.rosterComplete === true, 'incomplete_prospective_roster');
    check(Array.isArray(data.observations) && Array.isArray(data.missing)
      && data.observations.length + data.missing.length <= policy.maximumObservations, 'observation_budget');
    const input: Observation[] = [...data.observations.map(row => ({ ...row, provenance: row.outcome.provenance,
      activationAt: row.outcome.activationAt, costs: row.outcome.costs })), ...data.missing.map(row => ({ ...row, outcome: null }))];
    check(['paper_execution', 'live_execution', 'simulation', 'shadow'].includes(target.provenance), 'unsupported_provenance');
    if (target.provenance === 'paper_execution' || target.provenance === 'live_execution') {
      check(target.provenance === executionProvenance(target.scope), 'environment_mismatch');
    }
    check(plan.dataCutoff <= asOf && plan.session.calendarAsOf <= asOf && target.features.asOf <= asOf
      && plan.session.openAt <= asOf && asOf < plan.session.closeAt
      && asOf <= plan.entryWindow.from && asOf < plan.validUntil && plan.validUntil <= plan.entryWindow.to, 'future_target_context');
    cohort = context(plan, target.features, target.costs, plan.entryWindow.from);
    const latest = new Map<string, Observation>();
    for (const source of input) {
      // Future and foreign facts are unavailable at this as-of and cannot affect either fit or diagnostics.
      if (source.candidate.recordedAt > asOf || source.candidate.session.closeAt >= asOf
        || source.outcome && (source.outcome.recordedAt > asOf
          || source.candidate.session.tradingDate < windows.calibrationWindow.from.slice(0, 10) && source.outcome.recordedAt >= windows.calibrationWindow.from)
        || !sameScope(source.candidate.scope, target.scope) || source.provenance !== target.provenance) continue;
      const o = structuredClone(source), c = o.candidate, result = o.outcome, p = o.plan;
      validateProspectiveCandidate(c); if (result) validateProspectiveOutcome(result);
      check((!result || sameScope(result.scope, target.scope)) && sameScope(p.scope, target.scope), 'scope_mismatch');
      check(c.proposal && c.proposal.id === p.id && c.proposal.revision === p.revision && (!result || result.candidateId === c.id)
        && equal(c.evidence, p.evidence) && equal(c.template, p.template) && equal(c.policy, p.evidence.policy) && equal(c.parameters, p.parameters)
        && equal(c.session, p.session) && c.capitalCents === p.capital.ceilingCents && c.intendedEnd === p.intendedEnd
        && c.offeredAt! >= p.generatedAt && c.features.asOf <= c.offeredAt!, 'original_plan_mismatch');
      check((!result || result.horizonEnd === c.session.closeAt) && o.activationAt >= c.offeredAt!
        && (o.provenance === 'paper_execution' || o.provenance === 'live_execution' || o.activationAt === c.offeredAt), 'outcome_horizon_mismatch');
      const previous = latest.get(c.id);
      check(!previous || equal(previous.candidate, c) && equal(previous.plan, p), 'candidate_identity_conflict');
      check(!previous?.outcome || !result || previous.outcome.revision !== result.revision || equal(previous.outcome, result), 'outcome_revision_conflict');
      if (!previous || result && (!previous.outcome || result.revision > previous.outcome.revision)) latest.set(c.id, o);
    }
    // Select clusters using only original offer time/identity, before considering return or completeness.
    const clusters = new Set<string>();
    for (const o of [...latest.values()].sort((a, b) => compare(a.candidate.offeredAt!, b.candidate.offeredAt!) || compare(a.candidate.id, b.candidate.id))) {
      const c = o.candidate, result = o.outcome, date = c.session.tradingDate;
      if (date < windows.trainingWindow.from.slice(0, 10) || date >= plan.session.tradingDate) continue;
      let rowContext: string;
      try { rowContext = context(o.plan, c.features, o.costs, o.activationAt); } catch { continue; }
      if (rowContext !== cohort) continue;
      const key = `${date}/${c.symbol}`; if (clusters.has(key)) continue; clusters.add(key);
      let exclusion: string | null = result ? result.fitExclusions.length ? result.fitExclusions.join(';') : null : 'missing_finalized_outcome';
      if (!result || result.completeness !== 'complete' || result.netPnlUsd === null || !result.feesKnown || result.tradeStatus === 'unknown') exclusion ??= 'incomplete_net_outcome';
      if (Date.parse(o.activationAt) - Date.parse(c.offeredAt!) > policy.maximumApprovalDelayMs) exclusion ??= 'unsupported_approval_delay';
      const pnl = !result || result.netPnlUsd === null ? null : Number(result.netPnlUsd) * 100;
      if (pnl !== null && (!Number.isFinite(pnl) || Math.abs(pnl) > Number.MAX_SAFE_INTEGER / policy.maximumObservations)) exclusion ??= 'unsupported_cash_precision';
      rows.push({ observation: o, date, partition: date < windows.calibrationWindow.from.slice(0, 10) ? 'training' : 'calibration', exclusion, pnl });
    }
    const eligible = rows.filter(row => !row.exclusion), training = eligible.filter(row => row.partition === 'training'), later = eligible.filter(row => row.partition === 'calibration');
    trainingDates = new Set(training.map(r => r.date)).size; calibrationDates = new Set(later.map(r => r.date)).size;
    completeFraction = rows.length ? weighted(rows).filter(r => !r.row.exclusion).reduce((sum, r) => sum + r.weight, 0) : null;
    if (trainingDates < policy.minimumTrainingDates) reasons.push('insufficient_independent_training_sessions');
    if (calibrationDates < policy.minimumCalibrationDates) reasons.push('insufficient_independent_calibration_sessions');
    if (completeFraction === null || completeFraction + 1e-12 < policy.minimumCompleteFraction) reasons.push('incomplete_cohort');
    if (!reasons.length) {
      const train = weighted(training), calibrationRows = weighted(later);
      const rawLow = quantile(train, 0.1), rawHigh = quantile(train, 0.9);
      // Assess the same outward-rounded cent interval that is actually published.
      const low = Math.floor(rawLow), high = Math.ceil(rawHigh), width = high - low, average = mean(train);
      noTradeWeight = train.filter(row => row.row.observation.outcome?.tradeStatus === 'no_trade').reduce((sum, row) => sum + row.weight, 0);
      calibration = { coverage: calibrationRows.filter(r => r.pnl >= low && r.pnl <= high).reduce((sum, r) => sum + r.weight, 0),
        lowerTail: calibrationRows.filter(r => r.pnl < low).reduce((sum, r) => sum + r.weight, 0),
        upperTail: calibrationRows.filter(r => r.pnl > high).reduce((sum, r) => sum + r.weight, 0) };
      if (rawHigh <= rawLow || width / plan.capital.ceilingCents > policy.maximumWidthToCapital) reasons.push('unsupported_predictive_spread');
      const dates = [...new Set(training.map(r => r.date))].sort(), middle = dates[Math.floor(dates.length / 2)];
      const first = weighted(training.filter(r => r.date < middle)), second = weighted(training.filter(r => r.date >= middle));
      const permittedShift = Math.max(1, width * policy.maximumMeanShiftToWidth);
      if (Math.abs(mean(first) - mean(second)) > permittedShift) reasons.push('unstable_training_periods');
      if (calibration.coverage + 1e-12 < policy.minimumCoverage || calibration.lowerTail > policy.maximumTailFraction + 1e-12
        || calibration.upperTail > policy.maximumTailFraction + 1e-12 || Math.abs(mean(calibrationRows) - average) > permittedShift)
        reasons.push('failed_out_of_sample_calibration');
      if (!reasons.length) estimates = { mean: Math.round(average), median: Math.round(quantile(train, 0.5)), low: Math.round(low), high: Math.round(high) };
    }
  } catch (error) {
    reasons.push(error instanceof Error ? error.message : 'invalid_forecast_evidence');
  }
  const refs = rows.map(row => ({ candidate: row.observation.candidate, outcome: row.observation.outcome, plan: row.observation.plan }));
  const evidenceRef = await digest(refs), cohortRef = cohort ? await digest(cohort) : null;
  const observations = (['training', 'calibration'] as const).flatMap(partition => {
    const partitionRows = rows.filter(row => row.partition === partition), weights = weighted(partitionRows);
    return weights.map(({ row, weight }) => ({ candidateId: row.observation.candidate.id, outcomeId: row.observation.outcome?.id ?? null,
      date: row.date, partition, weight, exclusion: row.exclusion }));
  });
  const summary = { policy, asOf, provenance: target.provenance, evidenceRef, cohortRef, reasons,
    ...windows, trainingDates, calibrationDates, completeFraction, noTradeWeight, calibration, observations, limitations };
  const diagnostics: ForecastDiagnostics = { ...summary, id: await digest(summary) };
  const forecast: Forecast = estimates ? { status: 'experimental', meanPnlCents: estimates.mean, medianPnlCents: estimates.median,
    quantiles: [{ probability: 0.1, pnlCents: estimates.low }, { probability: 0.5, pnlCents: estimates.median }, { probability: 0.9, pnlCents: estimates.high }],
    probabilityOfProfit: null, asOf, validUntil: plan.validUntil, activationAt: plan.entryWindow.from, horizonEnd: plan.session.closeAt,
    capitalCents: plan.capital.ceilingCents, equityCents: plan.capital.equityCents, model: { id: policy.id, version: policy.version },
    evidenceRef, sampleCount: trainingDates, ...windows, diagnosticsRef: diagnostics.id, assumptions: target.costs }
    : unavailableForecast(reasons.join('; ') || 'Insufficient prospective evidence');
  return structuredClone({ forecast, diagnostics });
}
