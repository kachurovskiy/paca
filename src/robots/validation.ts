import { FULL_SESSION_CALENDAR } from '../core/exchange-session';
import type { AccountScope } from '../core/account';
import { finite, identifier, instant, integer, object, oneOf, requireValue } from '../core/validation';
import type { RobotProposal, TemplateParameterContract } from './domain';
import { validateParameters, validateSession } from './plan';
import { FORECAST_POLICY } from './research/forecast-policy';

function text(value: unknown, path: string): asserts value is string {
  requireValue(typeof value === 'string' && value.trim().length > 0 && value.length <= 4000, path, 'expected_nonempty_text');
}

export function validateScope(value: unknown, paperOnly = false): asserts value is AccountScope {
  const scope = object(value, 'scope', ['broker', 'accountId', 'environment']);
  identifier(scope.broker, 'scope.broker');
  identifier(scope.accountId, 'scope.accountId');
  oneOf(scope.environment, paperOnly ? ['paper'] : ['paper', 'live'], 'scope.environment');
}

export function sameScope(a: AccountScope, b: AccountScope): boolean {
  return a.broker === b.broker && a.accountId === b.accountId && a.environment === b.environment;
}

function versioned(value: unknown, path: string): { id: string; version: number } {
  const ref = object(value, path, ['id', 'version']);
  identifier(ref.id, `${path}.id`);
  integer(ref.version, `${path}.version`);
  return { id: ref.id, version: ref.version };
}

function textList(value: unknown, path: string): void {
  requireValue(Array.isArray(value), path, 'expected_array');
  for (const [index, item] of value.entries()) text(item, `${path}.${index}`);
}

export function validateVetoes(value: unknown, path: string): void {
  requireValue(Array.isArray(value), path, 'expected_array');
  for (const item of value) {
    const veto = object(item, path, ['category', 'code', 'reason']);
    oneOf(veto.category, ['portfolio', 'data', 'execution', 'capability', 'session', 'approval'], `${path}.category`);
    identifier(veto.code, `${path}.code`);
    text(veto.reason, `${path}.reason`);
  }
}

function window(value: unknown, path: string): { from: string; to: string } {
  const range = object(value, path, ['from', 'to']);
  instant(range.from, `${path}.from`);
  instant(range.to, `${path}.to`);
  requireValue(range.from < range.to, path, 'invalid_time_order');
  return { from: range.from, to: range.to };
}

export function opportunityKey(proposal: Pick<RobotProposal, 'scope' | 'template' | 'symbol' | 'session'>): string {
  return JSON.stringify([proposal.scope.broker, proposal.scope.accountId, proposal.scope.environment,
    proposal.template.id, proposal.symbol, proposal.session.calendarId, proposal.session.tradingDate]);
}

function validateForecast(value: unknown, proposal: RobotProposal): void {
  requireValue(value !== null && typeof value === 'object', 'forecast', 'expected_object');
  const status = (value as Record<string, unknown>).status;
  const metrics = ['meanPnlCents', 'medianPnlCents', 'quantiles', 'probabilityOfProfit'];
  if (status === 'unavailable') {
    const forecast = object(value, 'forecast', ['status', 'reason', ...metrics]);
    text(forecast.reason, 'forecast.reason');
    for (const key of metrics) requireValue(forecast[key] === null, `forecast.${key}`, 'unavailable_requires_null');
    return;
  }
  oneOf(status, ['experimental', 'validated'], 'forecast.status');
  const forecast = object(value, 'forecast', ['status', ...metrics, 'asOf', 'validUntil', 'activationAt', 'horizonEnd',
    'capitalCents', 'equityCents', 'model', 'evidenceRef', 'sampleCount', 'trainingWindow', 'calibrationWindow', 'diagnosticsRef', 'assumptions']);
  for (const key of ['meanPnlCents', 'medianPnlCents']) {
    if (forecast[key] !== null) {
      finite(forecast[key], `forecast.${key}`);
      requireValue(Number.isSafeInteger(forecast[key]), `forecast.${key}`, 'invalid_integer');
    }
  }
  if (forecast.probabilityOfProfit !== null) {
    finite(forecast.probabilityOfProfit, 'forecast.probabilityOfProfit');
    requireValue(forecast.probabilityOfProfit >= 0 && forecast.probabilityOfProfit <= 1, 'forecast.probabilityOfProfit', 'outside_probability_bounds');
  }
  if (forecast.quantiles !== null) {
    requireValue(Array.isArray(forecast.quantiles) && forecast.quantiles.length > 0, 'forecast.quantiles', 'expected_nonempty_array');
    let previousProbability = -1, previousPnl = -Infinity;
    for (const item of forecast.quantiles) {
      const quantile = object(item, 'forecast.quantiles', ['probability', 'pnlCents']);
      finite(quantile.probability, 'forecast.quantiles.probability');
      finite(quantile.pnlCents, 'forecast.quantiles.pnlCents');
      requireValue(quantile.probability > previousProbability && quantile.probability > 0 && quantile.probability < 1
        && Number.isSafeInteger(quantile.pnlCents) && quantile.pnlCents >= previousPnl, 'forecast.quantiles', 'invalid_quantile_order');
      previousProbability = quantile.probability;
      previousPnl = quantile.pnlCents;
    }
  }
  requireValue(metrics.some(key => forecast[key] !== null), 'forecast', 'numeric_forecast_requires_estimate');
  for (const key of ['asOf', 'validUntil', 'activationAt', 'horizonEnd']) instant(forecast[key], `forecast.${key}`);
  requireValue((forecast.asOf as string) <= proposal.generatedAt && (forecast.asOf as string) < (forecast.validUntil as string)
    && (forecast.validUntil as string) >= proposal.validUntil && (forecast.validUntil as string) <= proposal.entryWindow.to
    && forecast.activationAt === proposal.entryWindow.from && forecast.horizonEnd === proposal.session.closeAt,
  'forecast', 'invalid_forecast_horizon');
  requireValue(forecast.capitalCents === proposal.capital.ceilingCents && forecast.equityCents === proposal.capital.equityCents,
    'forecast', 'denominator_mismatch');
  versioned(forecast.model, 'forecast.model');
  identifier(forecast.evidenceRef, 'forecast.evidenceRef');
  identifier(forecast.diagnosticsRef, 'forecast.diagnosticsRef');
  integer(forecast.sampleCount, 'forecast.sampleCount');
  const training = window(forecast.trainingWindow, 'forecast.trainingWindow');
  const calibration = window(forecast.calibrationWindow, 'forecast.calibrationWindow');
  requireValue(training.to <= calibration.from && calibration.to <= (forecast.asOf as string), 'forecast', 'invalid_research_time_order');
  const assumptions = object(forecast.assumptions, 'forecast.assumptions', ['fees', 'spread', 'slippage', 'fills', 'liquidation']);
  for (const [key, assumption] of Object.entries(assumptions)) text(assumption, `forecast.assumptions.${key}`);
}

export function validateForecastEvidence(proposal: RobotProposal): void {
  if (!Object.hasOwn(proposal, 'forecastEvidence')) return;
  const e = object(proposal.forecastEvidence, 'forecastEvidence', ['schemaVersion', 'model', 'provenance', 'asOf', 'evidenceRef',
    'cohortRef', 'diagnosticsRef', 'trainingWindow', 'calibrationWindow', 'trainingDates', 'calibrationDates', 'completeFraction',
    'noTradeWeight', 'calibration', 'features', 'costs', 'reasons', 'limitations']);
  requireValue(e.schemaVersion === 1, 'forecastEvidence', 'unsupported_schema');
  versioned(e.model, 'forecastEvidence.model'); oneOf(e.provenance, ['paper_execution', 'live_execution', 'simulation', 'shadow'], 'forecastEvidence.provenance');
  if (e.provenance === 'paper_execution' || e.provenance === 'live_execution') requireValue(
    e.provenance === (proposal.scope.environment === 'live' ? 'live_execution' : 'paper_execution'), 'forecastEvidence', 'environment_mismatch');
  instant(e.asOf, 'forecastEvidence.asOf'); requireValue(e.asOf === proposal.generatedAt, 'forecastEvidence', 'as_of_mismatch');
  for (const key of ['evidenceRef', 'diagnosticsRef']) identifier(e[key], `forecastEvidence.${key}`);
  if (e.cohortRef !== null) identifier(e.cohortRef, 'forecastEvidence.cohortRef');
  const training = window(e.trainingWindow, 'forecastEvidence.trainingWindow'), calibration = window(e.calibrationWindow, 'forecastEvidence.calibrationWindow');
  requireValue(training.to <= calibration.from && calibration.to <= e.asOf, 'forecastEvidence', 'time_order');
  integer(e.trainingDates, 'trainingDates', 0); integer(e.calibrationDates, 'calibrationDates', 0);
  const fraction = (v: unknown) => { finite(v, 'forecastEvidence.fraction'); requireValue(v >= 0 && v <= 1 + 1e-12, 'forecastEvidence', 'invalid_fraction'); };
  for (const key of ['completeFraction', 'noTradeWeight']) if (e[key] !== null) fraction(e[key]);
  if (e.calibration !== null) {
    const c = object(e.calibration, 'forecastEvidence.calibration', ['coverage', 'lowerTail', 'upperTail']); Object.values(c).forEach(fraction);
    requireValue(Math.abs((c.coverage as number) + (c.lowerTail as number) + (c.upperTail as number) - 1) < 1e-9, 'forecastEvidence', 'invalid_coverage');
  }
  const costs = object(e.costs, 'forecastEvidence.costs', ['fees', 'spread', 'slippage', 'fills', 'liquidation']); Object.values(costs).forEach(v => text(v, 'forecastEvidence.costs'));
  const features = object(e.features, 'forecastEvidence.features', ['asOf', 'priceUsd', 'dailyLiquidityUsd']); instant(features.asOf, 'forecastEvidence.features.asOf');
  requireValue(features.asOf <= e.asOf, 'forecastEvidence', 'future_features');
  for (const key of ['priceUsd', 'dailyLiquidityUsd']) if (features[key] !== null) {
    finite(features[key], key); requireValue(key === 'priceUsd' ? (features[key] as number) > 0 : (features[key] as number) >= 0, key, 'invalid_forecast_feature');
  }
  textList(e.reasons, 'forecastEvidence.reasons'); textList(e.limitations, 'forecastEvidence.limitations');
  const f = proposal.forecast, evidence = proposal.forecastEvidence!;
  if (f.status !== 'unavailable') requireValue(f.status === 'experimental'
    && f.model.id === FORECAST_POLICY.id && f.model.version === FORECAST_POLICY.version
    && evidence.model.id === f.model.id && evidence.model.version === f.model.version && !evidence.reasons.length
    && f.evidenceRef === evidence.evidenceRef && f.diagnosticsRef === evidence.diagnosticsRef && f.asOf === evidence.asOf
    && f.sampleCount === evidence.trainingDates && evidence.trainingDates >= FORECAST_POLICY.minimumTrainingDates
    && evidence.calibrationDates >= FORECAST_POLICY.minimumCalibrationDates && evidence.completeFraction !== null
    && features.priceUsd !== null && features.dailyLiquidityUsd !== null
    && proposal.capital.ceilingCents / 100 / (features.dailyLiquidityUsd as number) <= FORECAST_POLICY.maximumCapitalToDailyLiquidity
    && evidence.completeFraction >= 1 - 1e-12 && evidence.calibration !== null && evidence.cohortRef !== null
    && evidence.calibration.coverage >= FORECAST_POLICY.minimumCoverage - 1e-12
    && evidence.calibration.lowerTail <= FORECAST_POLICY.maximumTailFraction + 1e-12
    && evidence.calibration.upperTail <= FORECAST_POLICY.maximumTailFraction + 1e-12
    && f.probabilityOfProfit === null && Object.keys(costs).every(k => costs[k] === f.assumptions[k as keyof typeof f.assumptions])
    && f.trainingWindow.from === training.from && f.trainingWindow.to === training.to
    && f.calibrationWindow.from === calibration.from && f.calibrationWindow.to === calibration.to, 'forecastEvidence', 'estimate_mismatch');
  else requireValue(evidence.reasons.length > 0, 'forecastEvidence', 'missing_unavailable_reason');
}

/** Strict boundary validation: never repairs, drops, normalizes, or defaults source data. */
export function validateProposal(value: unknown, templates: readonly TemplateParameterContract[]): asserts value is RobotProposal {
  const p = object(value, 'proposal', ['schemaVersion', 'scope', 'id', 'revision', 'opportunityKey', 'template', 'symbol',
    'direction', 'sessionMode', 'supervision', 'parameters', 'session', 'generatedAt', 'dataCutoff', 'validUntil', 'dataProvenanceRef',
    'capital', 'risk', 'executionPolicy', 'exitPolicy', 'entryWindow', 'intendedEnd', 'adaptationBounds', 'rationale', 'risks', 'blocks',
    'evidence', 'forecast', 'allocatorPolicy', 'portfolioSnapshotRef',
    ...(value !== null && typeof value === 'object' && Object.hasOwn(value, 'forecastEvidence') ? ['forecastEvidence'] : [])]);
  requireValue(p.schemaVersion === 1, 'schemaVersion', 'unsupported_schema');
  validateScope(p.scope);
  identifier(p.id, 'id');
  integer(p.revision, 'revision');
  const template = versioned(p.template, 'template');
  const matching = templates.filter(candidate => candidate.identity.id === template.id && candidate.identity.version === template.version);
  requireValue(matching.length === 1, 'template', 'unsupported_or_ambiguous_template');
  validateParameters(p.parameters, matching[0]);
  requireValue(typeof p.symbol === 'string' && /^[A-Z][A-Z0-9.-]{0,14}$/.test(p.symbol), 'symbol', 'invalid_symbol');
  oneOf(p.direction, ['long'], 'direction');
  oneOf(p.sessionMode, ['regular', '24x5'], 'sessionMode');
  oneOf(p.supervision, ['browser'], 'supervision');
  for (const key of ['generatedAt', 'dataCutoff', 'validUntil', 'intendedEnd']) instant(p[key], key);
  validateSession(p.session);
  const session = p.session;
  requireValue((p.sessionMode === '24x5') === (session.calendarId === FULL_SESSION_CALENDAR), 'sessionMode', 'session_mode_mismatch');
  const entry = window(p.entryWindow, 'entryWindow');
  requireValue((session.calendarAsOf as string) <= (p.generatedAt as string)
    && (session.openAt as string) <= entry.from && entry.to < (p.intendedEnd as string)
    && (p.intendedEnd as string) <= (session.closeAt as string)
    && (p.dataCutoff as string) <= (p.generatedAt as string) && (p.generatedAt as string) < (p.validUntil as string)
    && (p.validUntil as string) <= entry.to, 'proposal', 'invalid_time_order');
  const capital = object(p.capital, 'capital', ['ceilingCents', 'equityCents', 'snapshotAt']);
  integer(capital.ceilingCents, 'capital.ceilingCents');
  integer(capital.equityCents, 'capital.equityCents');
  requireValue(capital.ceilingCents <= capital.equityCents, 'capital', 'ceiling_exceeds_equity');
  instant(capital.snapshotAt, 'capital.snapshotAt');
  requireValue(capital.snapshotAt <= (p.generatedAt as string), 'capital.snapshotAt', 'future_snapshot');
  const risk = object(p.risk, 'risk', ['budgetCents', 'lossTriggerCents', 'policy']);
  integer(risk.budgetCents, 'risk.budgetCents');
  integer(risk.lossTriggerCents, 'risk.lossTriggerCents');
  requireValue(risk.budgetCents <= capital.ceilingCents && risk.lossTriggerCents <= capital.ceilingCents, 'risk', 'risk_exceeds_capital');
  versioned(risk.policy, 'risk.policy');
  for (const key of ['executionPolicy', 'exitPolicy', 'allocatorPolicy']) versioned(p[key], key);
  for (const key of ['dataProvenanceRef', 'portfolioSnapshotRef']) identifier(p[key], key);
  requireValue(p.adaptationBounds !== null && typeof p.adaptationBounds === 'object' && !Array.isArray(p.adaptationBounds), 'adaptationBounds', 'expected_object');
  object(p.adaptationBounds, 'adaptationBounds', Object.keys(p.adaptationBounds));
  for (const [key, value] of Object.entries(p.adaptationBounds)) {
    identifier(key, 'adaptationBounds.key');
    const bounds = object(value, `adaptationBounds.${key}`, ['min', 'max']);
    finite(bounds.min, `adaptationBounds.${key}.min`);
    finite(bounds.max, `adaptationBounds.${key}.max`);
    requireValue(bounds.min >= 0 && bounds.min <= bounds.max, `adaptationBounds.${key}`, 'invalid_bounds');
  }
  textList(p.rationale, 'rationale');
  textList(p.risks, 'risks');
  validateVetoes(p.blocks, 'blocks');
  const evidence = object(p.evidence, 'evidence', ['id', 'policy', 'status', 'provenance', 'asOf', 'dataCutoff', 'limitations']);
  identifier(evidence.id, 'evidence.id');
  versioned(evidence.policy, 'evidence.policy');
  oneOf(evidence.status, ['unavailable', 'experimental', 'validated'], 'evidence.status');
  oneOf(evidence.provenance, ['simulation', 'shadow', 'paper_execution', 'live_execution'], 'evidence.provenance');
  instant(evidence.asOf, 'evidence.asOf');
  instant(evidence.dataCutoff, 'evidence.dataCutoff');
  requireValue(evidence.dataCutoff <= evidence.asOf && evidence.asOf <= (p.generatedAt as string)
    && evidence.dataCutoff <= (p.dataCutoff as string), 'evidence', 'invalid_time_order');
  textList(evidence.limitations, 'evidence.limitations');
  // This assertion follows exhaustive field validation above; forecast validation uses those fields.
  const proposal = value as RobotProposal;
  requireValue(p.opportunityKey === opportunityKey(proposal), 'opportunityKey', 'opportunity_mismatch');
  validateForecast(p.forecast, proposal);
  validateForecastEvidence(proposal);
}
