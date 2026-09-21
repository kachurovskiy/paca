import type { Bar } from '../../core/types';
import { decimal, units } from '../../core/decimal';
import type { ProposalDocument } from '../documents';
import { executionProvenance, type ExecutionOutcomeFacts } from '../outcome-facts';
import { sameScope } from '../validation';
import { requireValue } from '../../core/validation';
import type { RobotProposal, ForecastEvidence } from '../domain';
import { replayMomentum } from '../math/momentum';
import { fullLegacySession } from '../templates/common';
import { trendFollowing } from '../templates/trend-following';
import { TREND_RESEARCH_POLICY } from './trend';
import { estimateSessionEnd, type ForecastDataset } from './forecasts';
import { validateProspectiveCandidate, validateProspectiveOutcome, type OutcomeAssumptions, type ProspectiveCandidate, type ProspectiveOutcome } from './prospective-records';

export const EXECUTION_OUTCOME_ASSUMPTIONS: OutcomeAssumptions = {
  fees: 'Attributable recorded actual fees only; unknown remains unavailable.',
  spread: 'Actual fill cash; separate spread attribution unavailable.',
  slippage: 'Actual fill cash; separate slippage attribution unavailable.',
  fills: 'Reconciled owned broker activities, never counterfactual fills.',
  liquidation: 'Confirmed owned exit only; missed horizon excluded.',
};

/** Adapt one self-contained offer to the retained empirical estimator's value interface. */
export function offeredCandidate(document: ProposalDocument): ProspectiveCandidate {
  const p = document.proposal;
  const candidate: ProspectiveCandidate = { schemaVersion: 1, scope: p.scope, id: p.id, batchId: p.dataProvenanceRef,
    recordedAt: p.generatedAt, dataCutoff: p.dataCutoff, template: p.template, policy: p.evidence.policy,
    symbol: p.symbol, parameters: p.parameters, session: p.session, intendedEnd: p.intendedEnd, selection: 'offered', reasons: [],
    proposal: { id: p.id, revision: p.revision }, offeredAt: p.generatedAt, capitalCents: p.capital.ceilingCents,
    source: { snapshotRef: p.dataProvenanceRef, asOf: p.dataCutoff, symbols: [p.symbol], membership: 'recorded_shortlist',
      inputSymbols: document.inputSymbols, testedConfigurations: document.testedConfigurations },
    evidence: p.evidence, assumptions: document.costs, features: { ...document.features,
      minutesToClose: (Date.parse(p.session.closeAt) - Date.parse(p.generatedAt)) / 60000 } };
  validateProspectiveCandidate(candidate); return candidate;
}

const unavailable = (reason: string) => ({ netPnlUsd: null, grossPnlUsd: null, tradeStatus: 'unknown' as const,
  completeness: 'incomplete' as const, feesKnown: false, fitExclusions: [reason] });

/** Preserved sparse Trend replay. Its explicit simulation exclusion prevents treating it as paper fills. */
export function simulateOfferedTrend(candidate: ProspectiveCandidate, plan: RobotProposal, bars: readonly Bar[]) {
  if (plan.sessionMode === '24x5' || plan.template.id !== 'trend-following' || plan.template.version !== 1 || !fullLegacySession(plan.session)
    || plan.evidence.policy.id !== TREND_RESEARCH_POLICY.id || plan.evidence.policy.version !== TREND_RESEARCH_POLICY.version) return unavailable('counterfactual_fill_model_unavailable');
  try { trendFollowing.validateParameters(plan.parameters); } catch { return unavailable('unsupported_parameters'); }
  const from = Date.parse(plan.session.openAt), to = Date.parse(plan.session.closeAt), interval = 300000;
  if (bars.length !== (to - from) / interval || bars.length > 80 || bars.some((bar, i) => Date.parse(bar.t) !== from + i * interval
    || ![bar.o, bar.h, bar.l, bar.c, bar.v].every(Number.isFinite) || Math.min(bar.o, bar.h, bar.l, bar.c) <= 0 || bar.v < 0
    || bar.l > Math.min(bar.o, bar.c) || bar.h < Math.max(bar.o, bar.c))) return unavailable('missing_or_invalid_activation_history');
  const observations = bars.filter(bar => Date.parse(bar.t) >= Date.parse(candidate.offeredAt!) && bar.t <= plan.intendedEnd)
    .map(bar => ({ time: Date.parse(bar.t), price: bar.o }));
  if (observations.at(-1)?.time !== Date.parse(plan.intendedEnd)) return unavailable('exit_observation_unavailable');
  const { fastPeriod, slowPeriod, stopLossPct, trailingStopPct } = plan.parameters;
  const replay = replayMomentum([...bars], { fastPeriod, slowPeriod, stopLossPct, trailingStopPct }, observations, to);
  const cents = Math.round(plan.capital.ceilingCents * replay.metrics.returnPct / 100);
  if (!Number.isSafeInteger(cents)) return unavailable('simulation_cash_unavailable');
  const pnl = decimal(BigInt(cents) * units('0.01'));
  return { netPnlUsd: pnl, grossPnlUsd: pnl, tradeStatus: replay.metrics.trades ? 'traded' as const : 'no_trade' as const,
    completeness: 'complete' as const, feesKnown: true, fitExclusions: ['sparse_legacy_simulation_not_execution_equivalent'] };
}

export function outcome(document: ProposalDocument, actual: ExecutionOutcomeFacts | null, bars: readonly Bar[], at: string): ProspectiveOutcome | null {
  const p = document.proposal, candidate = offeredCandidate(document);
  if (actual) requireValue(sameScope(actual.scope, p.scope) && actual.proposalId === p.id, 'outcome', 'execution_scope_mismatch');
  if (at < p.session.closeAt || actual && !actual.endedAt) return null;
  const revision = (document.outcome?.revision ?? 0) + 1;
  const record: ProspectiveOutcome = actual ? {
    schemaVersion: 1, scope: p.scope, id: `outcome/${p.id}/${revision}`, candidateId: p.id, revision, recordedAt: at,
    provenance: executionProvenance(actual.scope), activationAt: actual.activationAt, horizonEnd: p.session.closeAt, approvalId: actual.approvalId,
    runId: actual.runId, disposition: 'approved', completeness: actual.exclusions.length || actual.netPnlUsd === null ? 'incomplete' : 'complete',
    fitExclusions: [...new Set(actual.exclusions.length ? actual.exclusions : actual.netPnlUsd === null ? ['net_outcome_unavailable'] : [])],
    tradeStatus: actual.tradeStatus, netPnlUsd: actual.exclusions.length ? null : actual.netPnlUsd, grossPnlUsd: actual.grossPnlUsd,
    feesKnown: actual.feesKnown, costs: EXECUTION_OUTCOME_ASSUMPTIONS, inputRef: `run/${actual.runId}/${actual.endedAt}`,
    evidenceRefs: [actual.approvalId, `run/${actual.runId}`],
  } : {
    schemaVersion: 1, scope: p.scope, id: `outcome/${p.id}/${revision}`, candidateId: p.id, revision, recordedAt: at,
    provenance: p.template.id === 'trend-following' ? 'simulation' : 'shadow', activationAt: p.generatedAt,
    horizonEnd: p.session.closeAt, approvalId: null, runId: null, disposition: document.dismissed ? 'dismissed' : 'expired',
    ...simulateOfferedTrend(candidate, p, bars), costs: document.costs, inputRef: `session/${p.id}/${at}`, evidenceRefs: [p.dataProvenanceRef],
  };
  validateProspectiveOutcome(record); return record;
}

export async function forecastOffer(document: ProposalDocument, history: readonly ProposalDocument[]): Promise<RobotProposal> {
  const p = document.proposal;
  const data: ForecastDataset = { observations: history.flatMap(row => row.outcome ? [{ candidate: offeredCandidate(row), plan: row.proposal, outcome: row.outcome }] : []),
    missing: history.filter(row => !row.outcome).map(row => ({ candidate: offeredCandidate(row), plan: row.proposal,
      provenance: executionProvenance(row.proposal.scope), activationAt: row.proposal.generatedAt, costs: EXECUTION_OUTCOME_ASSUMPTIONS })), rosterComplete: true };
  const report = await estimateSessionEnd({ scope: p.scope, plan: p, provenance: executionProvenance(p.scope), costs: EXECUTION_OUTCOME_ASSUMPTIONS, features: document.features }, data);
  const d = report.diagnostics;
  const forecastEvidence: ForecastEvidence = { schemaVersion: 1, model: { id: d.policy.id, version: d.policy.version }, provenance: d.provenance,
    asOf: d.asOf, evidenceRef: d.evidenceRef, cohortRef: d.cohortRef, diagnosticsRef: d.id, trainingWindow: d.trainingWindow,
    calibrationWindow: d.calibrationWindow, trainingDates: d.trainingDates, calibrationDates: d.calibrationDates,
    completeFraction: d.completeFraction, noTradeWeight: d.noTradeWeight, calibration: d.calibration, features: document.features,
    costs: EXECUTION_OUTCOME_ASSUMPTIONS, reasons: d.reasons, limitations: d.limitations };
  return { ...p, forecast: report.forecast, forecastEvidence };
}
