import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, type Database } from '../core/database';
import { accountKey } from '../core/account';
import { ResearchDocuments, type ProposalDocument } from './documents';
import { opportunityKey, validateProposal } from './validation';
import type { RobotProposal } from './domain';
import { templates } from './templates/registry';
import { prospectiveBars, prospectiveDraft, scope } from './research/prospective-fixtures';
import { TREND_RESEARCH_POLICY } from './research/trend';
import { forecastOffer, offeredCandidate, outcome, EXECUTION_OUTCOME_ASSUMPTIONS, simulateOfferedTrend } from './research/outcomes';
import { validateProspectiveOutcome } from './research/prospective-records';
import { forecastFixture } from './research/forecast-fixtures';
import { meanReversionFixture, meanReversionReport } from './research/mean-reversion-fixtures';
import { researchMean } from './research/mean-service';

const opened: Database[] = [];
afterEach(() => { opened.splice(0).forEach(db => db.close()); });
async function setup() {
  const db = await openDatabase(`research-${crypto.randomUUID()}`); opened.push(db);
  return { db, documents: new ResearchDocuments(db, accountKey(scope)) };
}
function offer(): ProposalDocument {
  const draft = prospectiveDraft(), p = { ...draft, schemaVersion: 1 as const, scope, id: 'synthetic-offer', revision: 1 };
  const proposal: RobotProposal = { ...p, opportunityKey: opportunityKey(p) };
  return { key: JSON.stringify([accountKey(scope), p.id]), scope: accountKey(scope), kind: 'proposal', proposal,
    dismissed: false, outcome: null, features: { asOf: p.dataCutoff, priceUsd: 100, dailyLiquidityUsd: 10000000 },
    costs: TREND_RESEARCH_POLICY.assumptions, inputSymbols: 1, testedConfigurations: 3 };
}

describe('self-contained current research records', () => {
  it('retains an exact offer, user disposition and outcome without an identity graph', async () => {
    const { documents } = await setup(), document = offer(), p = document.proposal;
    await documents.saveProposal(p, document);
    const result = outcome(document, null, prospectiveBars(p), p.session.closeAt)!;
    await Promise.all([documents.saveProposal(p, undefined, true), documents.saveOutcome(p.id, result)]);
    expect(await documents.load()).toEqual([{ ...document, dismissed: true, outcome: result }]);
    await expect(documents.saveProposal({ ...p, parameters: { ...p.parameters, fastPeriod: 3 } }, document)).rejects.toThrow('immutable');
  });
  it.each(['features', 'outcome', 'scope'])('rejects damaged %s at the research boundary', async field => {
    const { db, documents } = await setup(), document = offer();
    await documents.saveProposal(document.proposal, document);
    await db.put('research', { ...document, [field]: field === 'scope' ? accountKey(scope) : { incomplete: true },
      ...(field === 'scope' ? { proposal: { ...document.proposal, scope: { ...scope, accountId: 'foreign' } } } : {}) });
    await expect(documents.load()).rejects.toThrow();
  });
  it('preserves sparse simulation numbers while refusing incomplete or unsupported fill evidence', () => {
    const document = offer(), p = document.proposal, candidate = offeredCandidate(document), bars = prospectiveBars(p);
    expect(simulateOfferedTrend(candidate, p, bars)).toMatchObject({ completeness: 'complete', netPnlUsd: '0', tradeStatus: 'no_trade',
      fitExclusions: ['sparse_legacy_simulation_not_execution_equivalent'] });
    expect(simulateOfferedTrend(candidate, p, bars.slice(1))).toMatchObject({ completeness: 'incomplete', netPnlUsd: null });
    expect(simulateOfferedTrend(candidate, { ...p, template: { id: 'wick-capture', version: 1 } }, bars)).toMatchObject({ netPnlUsd: null, feesKnown: false });
    expect(outcome(document, null, bars, p.generatedAt)).toBeNull();
  });
  it('keeps actual paper gross results, missing fees and supervision exclusions distinct', () => {
    const document = offer(), p = document.proposal;
    const paper = { scope: p.scope, proposalId: p.id, runId: 'run-synthetic', approvalId: 'approval-synthetic', activationAt: p.generatedAt,
      endedAt: p.intendedEnd, grossPnlUsd: '12.5', netPnlUsd: null, feesKnown: false, tradeStatus: 'traded' as const, exclusions: ['fees_unavailable'] };
    const result = outcome(document, paper, [], p.session.closeAt)!;
    expect(result).toMatchObject({ provenance: 'paper_execution', completeness: 'incomplete', grossPnlUsd: '12.5', netPnlUsd: null, feesKnown: false });
    expect(outcome(document, { ...paper, endedAt: null }, [], p.session.closeAt)).toBeNull();
    expect(outcome(document, { ...paper, feesKnown: true, netPnlUsd: '12', exclusions: ['interrupted_supervision'] }, [], p.session.closeAt)?.netPnlUsd).toBeNull();
  });
  it('validates concrete chronological reports and reuses already exposed histories', async () => {
    const { documents, db } = await setup(), fixture = meanReversionFixture(), request = await fixture.request();
    const report = meanReversionReport(request);
    await documents.saveExperiment('synthetic-experiment', report.exposure, report);
    expect((await documents.load())[0]).toMatchObject({ report });
    await db.put('research', { key: JSON.stringify([accountKey(scope), 'synthetic-experiment']), scope: accountKey(scope),
      kind: 'experiment', id: 'synthetic-experiment', exposure: report.exposure, report: { ...report, evaluations: [{ netReturnPct: 1 }] } });
    await expect(documents.load()).rejects.toThrow();
    const fresh = await setup(), snapshot = await fixture.capture();
    await researchMean(snapshot, fixture.api, fresh.documents, new AbortController().signal, () => fixture.now);
    const first = await fresh.documents.load();
    await researchMean(snapshot, fixture.api, fresh.documents, new AbortController().signal, () => fixture.now);
    expect(await fresh.documents.load()).toEqual(first);
    expect(first.some(row => row.kind === 'experiment' && row.report !== null)).toBe(true);
  });
  it('persists live outcomes separately and rejects paper or foreign execution evidence', async () => {
    const { db } = await setup(), original = offer(), liveScope = { ...scope, environment: 'live' as const };
    const plan = { ...original.proposal, scope: liveScope };
    const document = { ...original, scope: accountKey(liveScope), key: JSON.stringify([accountKey(liveScope), plan.id]),
      proposal: { ...plan, opportunityKey: opportunityKey(plan) } };
    const documents = new ResearchDocuments(db, accountKey(liveScope));
    const forecast = await forecastOffer(document, []);
    expect(forecast.forecastEvidence?.provenance).toBe('live_execution');
    await documents.saveProposal(forecast, document);
    const actual = { scope: liveScope, proposalId: plan.id, runId: 'live-run', approvalId: 'live-approval', activationAt: plan.generatedAt,
      endedAt: plan.intendedEnd, grossPnlUsd: '12.5', netPnlUsd: '12', feesKnown: true, tradeStatus: 'traded' as const, exclusions: [] };
    const result = outcome(document, actual, [], plan.session.closeAt)!;
    expect(result).toMatchObject({ provenance: 'live_execution', scope: liveScope, netPnlUsd: '12' });
    await documents.saveOutcome(plan.id, result);
    expect((await documents.load())[0]).toMatchObject({ outcome: result });
    expect(await new ResearchDocuments(db, accountKey(scope)).load()).toEqual([]);
    expect(() => outcome(document, { ...actual, scope }, [], plan.session.closeAt)).toThrow('execution_scope_mismatch');
    expect(() => outcome(document, { ...actual, proposalId: 'foreign' }, [], plan.session.closeAt)).toThrow('execution_scope_mismatch');
    expect(() => validateProspectiveOutcome({ ...result, provenance: 'paper_execution' })).toThrow('environment_mismatch');
    expect(() => validateProposal({ ...forecast, forecastEvidence: { ...forecast.forecastEvidence!, provenance: 'paper_execution' } }, templates)).toThrow('environment_mismatch');
  });
  it('keeps insufficient forecast values null and stores diagnostics for a qualified synthetic cohort', async () => {
    const empty = await forecastOffer(offer(), []);
    expect(empty.forecast).toMatchObject({ status: 'unavailable', meanPnlCents: null, medianPnlCents: null });
    expect(() => validateProposal(empty, templates)).not.toThrow();
    const f = forecastFixture();
    const current = offer();
    const history: ProposalDocument[] = f.observations.map(row => ({ ...current, key: JSON.stringify([accountKey(scope), row.plan.id]),
      proposal: row.plan, features: row.candidate.features,
      outcome: { ...row.outcome, candidateId: row.plan.id, provenance: 'paper_execution', disposition: 'approved',
        activationAt: new Date(Date.parse(row.plan.generatedAt) + 5000).toISOString(), approvalId: 'synthetic-approval', runId: row.plan.id, costs: EXECUTION_OUTCOME_ASSUMPTIONS } }));
    const forecast = await forecastOffer(current, history);
    expect(forecast.forecast).toMatchObject({ status: 'experimental', meanPnlCents: 100, sampleCount: 30 });
    expect(forecast.forecastEvidence).toMatchObject({ trainingDates: 30, calibrationDates: 20 });
    expect(() => validateProposal(forecast, templates)).not.toThrow();
    const { documents } = await setup();
    await documents.saveProposal(forecast, current);
    expect((await documents.load())[0]).toMatchObject({ proposal: { forecast: { status: 'experimental', meanPnlCents: 100 } } });
    const livePlan = { ...current.proposal, scope: { ...current.proposal.scope, environment: 'live' as const } };
    const live = await forecastOffer({ ...current, proposal: { ...livePlan, opportunityKey: opportunityKey(livePlan) } }, history);
    expect(live.forecast).toMatchObject({ status: 'unavailable', meanPnlCents: null });
    expect(live.forecastEvidence).toMatchObject({ provenance: 'live_execution', trainingDates: 0, calibrationDates: 0 });
  });
});
