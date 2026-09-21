import type { EvidenceReference, RobotSession, ScopedRecord, VersionedIdentity } from '../domain';
import { identifier, instant, integer, object, oneOf, requireValue } from '../../core/validation';
import { validateScope } from '../validation';
import { validateSession } from '../plan';
import { executionProvenance } from '../outcome-facts';
import type { AccountScope } from '../../core/account';

export const PROSPECTIVE_POLICY = Object.freeze({ id: 'prospective-observations', version: 1,
  candidatesPerPublication: 90, candidatesPerAccount: 100_000, outcomesPerAccount: 200_000,
  finalizationsPerCycle: 30, historyRequestsPerCycle: 4, historyPages: 2, historyBars: 80, refreshMs: 60_000, durationMs: 20_000 });
export interface OutcomeAssumptions {
  readonly fees: string; readonly spread: string; readonly slippage: string; readonly fills: string; readonly liquidation: string;
}
/** Compact non-reproducible as-of facts. Never delete these to free a research cache. */
export interface ProspectiveCandidate extends ScopedRecord {
  readonly batchId: string; readonly recordedAt: string; readonly dataCutoff: string;
  readonly template: VersionedIdentity; readonly policy: VersionedIdentity;
  readonly symbol: string; readonly parameters: Readonly<Record<string, number>> | null;
  readonly session: RobotSession; readonly intendedEnd: string | null;
  readonly selection: 'offered' | 'eligible_rejected' | 'research_rejected' | 'unavailable' | 'omitted';
  readonly reasons: readonly string[];
  readonly proposal: { readonly id: string; readonly revision: number } | null;
  readonly offeredAt: string | null; readonly capitalCents: number | null;
  readonly source: { readonly snapshotRef: string; readonly asOf: string;
    readonly symbols: readonly string[]; readonly membership: 'recorded_shortlist' | 'supplied_symbols';
    readonly inputSymbols: number; readonly testedConfigurations: number };
  readonly evidence: EvidenceReference | null;
  readonly assumptions: OutcomeAssumptions;
  readonly features: { readonly asOf: string; readonly priceUsd: number | null; readonly dailyLiquidityUsd: number | null;
    readonly minutesToClose: number };
}
export interface ProspectiveOutcome extends ScopedRecord {
  readonly candidateId: string; readonly revision: number; readonly recordedAt: string;
  readonly provenance: 'paper_execution' | 'live_execution' | 'simulation' | 'shadow';
  readonly activationAt: string; readonly horizonEnd: string;
  readonly approvalId: string | null; readonly runId: string | null;
  readonly disposition: 'approved' | 'dismissed' | 'superseded' | 'expired' | 'invalidated' | 'pending';
  readonly completeness: 'complete' | 'incomplete'; readonly fitExclusions: readonly string[];
  readonly tradeStatus: 'traded' | 'no_trade' | 'unknown';
  readonly netPnlUsd: string | null; readonly grossPnlUsd: string | null;
  readonly feesKnown: boolean; readonly costs: OutcomeAssumptions;
  readonly inputRef: string; readonly evidenceRefs: readonly string[];
}

function version(value: unknown): void {
  const row = object(value, 'version', ['id', 'version']); identifier(row.id, 'version.id'); integer(row.version, 'version.version');
}
function texts(value: unknown, label: string, max = 100): void {
  requireValue(Array.isArray(value) && value.length <= max, label, 'invalid_list');
  value.forEach(v => requireValue(typeof v === 'string' && v.trim().length > 0 && v.length <= 4000, label, 'invalid_text'));
}
export function validateOutcomeAssumptions(value: unknown): asserts value is OutcomeAssumptions {
  const row = object(value, 'assumptions', ['fees', 'spread', 'slippage', 'fills', 'liquidation']); texts(Object.values(row), 'assumptions');
}
function base(row: Record<string, unknown>): void {
  requireValue(row.schemaVersion === 1, 'schemaVersion', 'unsupported_schema'); validateScope(row.scope); identifier(row.id, 'id');
  instant(row.recordedAt, 'recordedAt');
}
export function validateProspectiveCandidate(value: unknown): asserts value is ProspectiveCandidate {
  const row = object(value, 'candidate', ['schemaVersion', 'scope', 'id', 'batchId', 'recordedAt', 'dataCutoff', 'template', 'policy',
    'symbol', 'parameters', 'session', 'intendedEnd', 'selection', 'reasons', 'proposal', 'offeredAt', 'capitalCents', 'source',
    'evidence', 'assumptions', 'features']);
  base(row); identifier(row.batchId, 'batchId'); instant(row.dataCutoff, 'dataCutoff'); version(row.template); version(row.policy);
  requireValue(typeof row.symbol === 'string' && /^[A-Z][A-Z0-9.-]{0,14}$/.test(row.symbol), 'symbol', 'invalid_symbol');
  validateSession(row.session); const session = row.session;
  requireValue(row.dataCutoff <= (row.recordedAt as string) && session.calendarAsOf <= (row.recordedAt as string)
    && session.openAt <= (row.recordedAt as string) && (row.recordedAt as string) < session.closeAt, 'candidate', 'not_prospective');
  if (row.parameters !== null) {
    requireValue(typeof row.parameters === 'object' && !Array.isArray(row.parameters), 'parameters', 'invalid_parameters');
    const params = row.parameters as Record<string, unknown>;
    requireValue(Object.keys(params).length > 0 && Object.keys(params).length <= 20
      && Object.values(params).every(v => typeof v === 'number' && Number.isFinite(v)), 'parameters', 'invalid_parameters');
    Object.keys(params).forEach(key => identifier(key, 'parameter'));
  }
  if (row.intendedEnd !== null) { instant(row.intendedEnd, 'intendedEnd'); requireValue(row.intendedEnd <= session.closeAt, 'intendedEnd', 'outside_session'); }
  oneOf(row.selection, ['offered', 'eligible_rejected', 'research_rejected', 'unavailable', 'omitted'], 'selection'); texts(row.reasons, 'reasons');
  if (row.proposal !== null) {
    const proposal = object(row.proposal, 'proposal', ['id', 'revision']); identifier(proposal.id, 'proposal.id'); integer(proposal.revision, 'revision');
    instant(row.offeredAt, 'offeredAt'); integer(row.capitalCents, 'capitalCents');
    requireValue(row.selection === 'offered' && row.offeredAt === row.recordedAt && row.parameters !== null && row.evidence !== null
      && typeof row.intendedEnd === 'string' && row.offeredAt < row.intendedEnd, 'offered', 'invalid_offer');
  } else requireValue(row.selection !== 'offered' && row.offeredAt === null && row.capitalCents === null, 'candidate', 'unoffered_capital');
  const source = object(row.source, 'source', ['snapshotRef', 'asOf', 'symbols', 'membership', 'inputSymbols', 'testedConfigurations']);
  identifier(source.snapshotRef, 'source.snapshotRef'); instant(source.asOf, 'source.asOf');
  requireValue(source.asOf <= (row.recordedAt as string), 'source', 'future_source');
  texts(source.symbols, 'source.symbols', 30); oneOf(source.membership, ['recorded_shortlist', 'supplied_symbols'], 'membership');
  requireValue(new Set(source.symbols as string[]).size === (source.symbols as string[]).length
    && (source.symbols as string[]).includes(row.symbol), 'source', 'missing_symbol');
  integer(source.inputSymbols, 'inputSymbols', 0); integer(source.testedConfigurations, 'testedConfigurations', 0);
  if (row.evidence !== null) {
    const evidence = object(row.evidence, 'evidence', ['id', 'policy', 'status', 'provenance', 'asOf', 'dataCutoff', 'limitations']);
    identifier(evidence.id, 'evidence.id'); version(evidence.policy); oneOf(evidence.status, ['unavailable', 'experimental', 'validated'], 'evidence.status');
    oneOf(evidence.provenance, ['simulation', 'shadow', 'paper_execution', 'live_execution'], 'evidence.provenance');
    instant(evidence.asOf, 'evidence.asOf'); instant(evidence.dataCutoff, 'evidence.dataCutoff'); texts(evidence.limitations, 'limitations');
    requireValue(evidence.dataCutoff <= evidence.asOf && evidence.asOf <= (row.recordedAt as string), 'evidence', 'future_evidence');
  }
  validateOutcomeAssumptions(row.assumptions);
  const features = object(row.features, 'features', ['asOf', 'priceUsd', 'dailyLiquidityUsd', 'minutesToClose']);
  instant(features.asOf, 'features.asOf'); requireValue(features.asOf <= (row.recordedAt as string), 'features', 'future_features');
  for (const key of ['priceUsd', 'dailyLiquidityUsd']) requireValue(features[key] === null
    || typeof features[key] === 'number' && Number.isFinite(features[key]) && (key === 'priceUsd' ? features[key] > 0 : features[key] >= 0), key, 'invalid_feature');
  requireValue(typeof features.minutesToClose === 'number' && Number.isFinite(features.minutesToClose)
    && Math.abs(features.minutesToClose - (Date.parse(session.closeAt) - Date.parse(row.recordedAt as string)) / 60_000) < 1e-8,
  'features', 'horizon_mismatch');
}
export function validateProspectiveOutcome(value: unknown): asserts value is ProspectiveOutcome {
  const row = object(value, 'outcome', ['schemaVersion', 'scope', 'id', 'candidateId', 'revision', 'recordedAt', 'provenance',
    'activationAt', 'horizonEnd', 'approvalId', 'runId', 'disposition', 'completeness', 'fitExclusions', 'tradeStatus',
    'netPnlUsd', 'grossPnlUsd', 'feesKnown', 'costs', 'inputRef', 'evidenceRefs']);
  base(row); identifier(row.candidateId, 'candidateId'); integer(row.revision, 'revision');
  oneOf(row.provenance, ['paper_execution', 'live_execution', 'simulation', 'shadow'], 'provenance');
  instant(row.activationAt, 'activationAt'); instant(row.horizonEnd, 'horizonEnd');
  requireValue(row.activationAt < row.horizonEnd && row.horizonEnd <= (row.recordedAt as string), 'outcome', 'horizon_not_complete');
  const executed = row.provenance === 'paper_execution' || row.provenance === 'live_execution';
  if (executed) {
    requireValue(row.provenance === executionProvenance(row.scope as AccountScope), 'outcome', 'environment_mismatch');
    identifier(row.approvalId, 'approvalId'); identifier(row.runId, 'runId');
  }
  else requireValue(row.approvalId === null && row.runId === null, 'outcome', 'counterfactual_run');
  oneOf(row.disposition, ['approved', 'dismissed', 'superseded', 'expired', 'invalidated', 'pending'], 'disposition');
  requireValue(executed ? row.disposition === 'approved' : row.disposition !== 'approved', 'outcome', 'provenance_disposition');
  oneOf(row.completeness, ['complete', 'incomplete'], 'completeness'); texts(row.fitExclusions, 'fitExclusions');
  oneOf(row.tradeStatus, ['traded', 'no_trade', 'unknown'], 'tradeStatus');
  for (const key of ['netPnlUsd', 'grossPnlUsd']) if (row[key] !== null) requireValue(typeof row[key] === 'string'
    && /^-?(0|[1-9]\d{0,31})(\.\d{0,23}[1-9])?$/.test(row[key]) && row[key] !== '-0', key, 'invalid_derived_cash');
  requireValue(typeof row.feesKnown === 'boolean', 'feesKnown', 'invalid_boolean');
  requireValue(row.netPnlUsd === null || row.feesKnown, 'outcome', 'unknown_fees');
  if (row.completeness === 'complete') requireValue(row.netPnlUsd !== null && row.grossPnlUsd !== null
    && row.tradeStatus !== 'unknown' && row.feesKnown, 'outcome', 'incomplete_value');
  else requireValue((row.fitExclusions as string[]).length > 0 && row.netPnlUsd === null, 'outcome', 'missing_exclusion');
  if (row.tradeStatus === 'no_trade' && row.completeness === 'complete') requireValue(row.netPnlUsd === '0' && row.grossPnlUsd === '0', 'outcome', 'invalid_zero');
  validateOutcomeAssumptions(row.costs); identifier(row.inputRef, 'inputRef'); texts(row.evidenceRefs, 'evidenceRefs', 1000);
}
