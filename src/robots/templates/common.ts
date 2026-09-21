import { FULL_SESSION_CALENDAR, validFullSession } from '../../core/exchange-session';
import type { DecisionCondition, RobotSession, TemplateIdentity, Veto } from '../domain';
import { quantityWithinBudget, validateQuantity } from '../../core/precision';
import { DomainValidationError, identifier, instant, requireValue } from '../../core/validation';
import { sameScope } from '../validation';
import { validateParameters } from '../plan';
import type { CandidateIntent, DiscoveryEligibilityInput, ResearchCapability, StrategyTemplate, TemplateInput, TemplateResult, TemplateState } from './types';

export const SUPPORT = Object.freeze({ assets: ['us_equity'] as const, direction: 'long', session: '24x5', environments: ['paper', 'live'] as const, supervision: 'browser' } as const);
export const QUOTE_MAX_AGE_MS = 30_000;
const ny = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

export function initialTemplateState(template: TemplateIdentity): TemplateState {
  return { schemaVersion: 1, template: { ...template }, positionKey: null, observedPeak: null, firstFillAt: null, signal: null };
}

export function sameIdentity(a: TemplateIdentity, b: TemplateIdentity): boolean { return a.id === b.id && a.version === b.version; }
export function positive(value: number | null): value is number { return value !== null && Number.isFinite(value) && value > 0; }
export function veto(category: Veto['category'], code: string, reason: string): Veto { return { category, code, reason }; }

export function condition(code: string, inputRef: string, observed: number | string | boolean | null,
  operator: DecisionCondition['operator'], threshold: number | string | boolean, passes: boolean): DecisionCondition {
  return observed === null || typeof observed === 'number' && !Number.isFinite(observed)
    ? { code, inputRef, operator, threshold, observed: null, result: 'unavailable', reason: 'Required observation is unavailable' }
    : { code, inputRef, operator, threshold, observed, result: passes ? 'pass' : 'fail' };
}

export function result(input: TemplateInput, reasonCode: string, state = input.state,
  intent: CandidateIntent | null = null, conditions: readonly DecisionCondition[] = [], vetoes: readonly Veto[] = []): TemplateResult {
  // Detached output: later caller changes cannot rewrite a recorded decision/state.
  return structuredClone({ intent, state, decision: {
    schemaVersion: 1, scope: input.approved.scope, id: input.decisionId, runId: input.runId,
    evaluatedAt: input.evaluatedAt, dataCutoff: input.market.dataCutoff, template: input.approved.plan.template,
    policy: input.approved.plan.executionPolicy,
    inputRefs: [input.market.inputRef, input.approved.id], conditions,
    candidate: intent && intent.kind !== 'cancel' ? { side: intent.side, quantity: intent.quantity } : null,
    vetoes, action: intent?.kind === 'entry' ? 'request_entry' : intent?.kind === 'exit' ? 'request_exit'
      : intent?.kind === 'cancel' ? 'request_cancel' : 'hold', reasonCode,
  } });
}

export function blocked(input: TemplateInput, block: Veto, state = input.state): TemplateResult {
  return result(input, block.code, state, null, [], [block]);
}

export function sessionDate(time: string): string {
  const parts = ny.formatToParts(Date.parse(time));
  const get = (name: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === name)!.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Structural calendar check only; the caller must supply authoritative calendar evidence. */
export function validSession(session: RobotSession): boolean {
  try {
    instant(session.openAt, 'session.openAt'); instant(session.closeAt, 'session.closeAt'); instant(session.calendarAsOf, 'session.calendarAsOf');
    identifier(session.calendarId, 'session.calendarId'); identifier(session.provenanceRef, 'session.provenanceRef');
    if (session.calendarId === FULL_SESSION_CALENDAR) return session.timeZone === 'America/New_York' && validFullSession(session.tradingDate, session.openAt, session.closeAt);
    const parts = ny.formatToParts(Date.parse(session.openAt));
    const weekday = parts.find(part => part.type === 'weekday')!.value;
    return session.timeZone === 'America/New_York' && session.openAt < session.closeAt
      && sessionDate(session.openAt) === session.tradingDate
      && sessionDate(session.closeAt) === session.tradingDate && weekday !== 'Sat' && weekday !== 'Sun';
  } catch { return false; }
}

export function fullLegacySession(session: RobotSession): boolean {
  if (!validSession(session)) return false;
  const minute = (time: string) => {
    const parts = ny.formatToParts(Date.parse(time));
    return Number(parts.find(part => part.type === 'hour')!.value) * 60 + Number(parts.find(part => part.type === 'minute')!.value);
  };
  return minute(session.openAt) === 570 && minute(session.closeAt) === 960
    && Date.parse(session.closeAt) - Date.parse(session.openAt) === 390 * 60_000;
}

export function supportedTradingSession(session: RobotSession): boolean {
  return fullLegacySession(session) || session.calendarId === FULL_SESSION_CALENDAR && validSession(session);
}

export function discoveryEligibility(template: StrategyTemplate, input: DiscoveryEligibilityInput): readonly Veto[] {
  const blocks: Veto[] = [];
  try { instant(input.dataCutoff, 'dataCutoff'); }
  catch { return [veto('data', 'invalid_data_cutoff', 'A canonical UTC cutoff is required')]; }
  if (!validSession(input.session) || input.session.calendarAsOf > input.dataCutoff
    || input.dataCutoff < input.session.openAt || input.dataCutoff >= input.session.closeAt) {
    blocks.push(veto('session', 'session_unavailable', 'A current authoritative trading session is required'));
  }
  const dataCapabilities: readonly ResearchCapability[] = ['completed_5min_bars', 'observed_prices', 'bid_ask'];
  for (const capability of dataCapabilities) if (template.requiredCapabilities.includes(capability) && !input.capabilities.includes(capability)) {
    blocks.push(veto('capability', 'missing_data_capability', `Required data capability: ${capability}`));
  }
  const fresh = (at: string | null): boolean => {
    try { instant(at, 'observation.at'); } catch { return false; }
    return at! >= input.session.openAt && at! <= input.dataCutoff && Date.parse(input.dataCutoff) - Date.parse(at!) <= QUOTE_MAX_AGE_MS;
  };
  const quote = input.quote;
  if (!quote || !positive(quote.price) || !fresh(quote.tradeAt)) blocks.push(veto('data', 'trade_unavailable', 'A positive trade observed within 30 seconds of the cutoff is required'));
  if (template.requiredCapabilities.includes('bid_ask') && (!quote || !positive(quote.bid) || !positive(quote.ask)
    || quote.bid > quote.ask || !fresh(quote.quoteAt))) blocks.push(veto('data', 'bid_ask_unavailable', 'A fresh positive uncrossed bid and ask is required'));
  return blocks;
}

export function eligibility(template: StrategyTemplate, input: TemplateInput): readonly Veto[] {
  const blocks: Veto[] = [];
  if (!sameIdentity(template.identity, input.approved.plan.template)) blocks.push(veto('capability', 'unsupported_template_version', 'This exact template version is unavailable'));
  if (!template.support.environments.includes(input.approved.scope.environment) || !template.support.environments.includes(input.approved.plan.scope.environment)) {
    blocks.push(veto('capability', 'unsupported_environment', 'A supported paper or live account environment is required'));
  }
  if (input.market.assetClass !== 'us_equity') blocks.push(veto('capability', 'unsupported_asset', 'US equities are required'));
  for (const capability of template.requiredCapabilities) {
    if (!input.market.capabilities.includes(capability)) blocks.push(veto('capability', 'missing_capability', `Required capability: ${capability}`));
  }
  if (!sameIdentity(template.executionPolicy, input.approved.plan.executionPolicy) || !sameIdentity(template.exitPolicy, input.approved.plan.exitPolicy)) {
    blocks.push(veto('capability', 'unsupported_policy', 'The approved execution/exit policy is not supported by this template'));
  }
  return blocks;
}

/** Shared pure input checks; not the future atomic approval/admission transaction. */
export function preflight(template: StrategyTemplate, input: TemplateInput): TemplateResult | null {
  const blocks = eligibility(template, input);
  if (blocks.length) return result(input, blocks[0].code, input.state, null, [], blocks);
  try {
    validateParameters(input.approved.plan.parameters, template);
    instant(input.evaluatedAt, 'evaluatedAt'); instant(input.market.dataCutoff, 'dataCutoff'); instant(input.approved.approvedAt, 'approvedAt');
    identifier(input.runId, 'runId'); identifier(input.decisionId, 'decisionId'); identifier(input.market.inputRef, 'market.inputRef');
    requireValue(input.approved.schemaVersion === 1 && sameScope(input.approved.scope, input.approved.plan.scope)
      && input.approved.approvedAt >= input.approved.plan.generatedAt && input.approved.approvedAt < input.approved.plan.validUntil
      && input.approved.approvedAt <= input.evaluatedAt, 'approval', 'invalid_approved_snapshot');
    requireValue(input.market.symbol === input.approved.plan.symbol && input.market.dataCutoff <= input.evaluatedAt, 'market', 'invalid_market_snapshot');
    requireValue(input.state.schemaVersion === 1 && sameIdentity(input.state.template, template.identity), 'state', 'unsupported_state_version');
    if (input.state.positionKey !== null) identifier(input.state.positionKey, 'state.positionKey');
    if (input.state.observedPeak) {
      requireValue(positive(input.state.observedPeak.priceUsd), 'state.peak', 'invalid_peak');
      instant(input.state.observedPeak.at, 'state.peak.at');
      requireValue(input.state.observedPeak.at <= input.market.dataCutoff, 'state.peak.at', 'future_peak');
    }
    if (input.state.firstFillAt !== null) {
      instant(input.state.firstFillAt, 'state.firstFillAt');
      requireValue(input.state.firstFillAt <= input.evaluatedAt, 'state.firstFillAt', 'future_fill');
    }
    const signal = input.state.signal;
    if (signal) {
      // Protective exits may have an observed price but no bar history. Preserve
      // that actual observation identity explicitly; never synthesize a candle.
      const observation = signal.inputRef.startsWith('observation:');
      const signalAt = observation ? signal.inputRef.slice('observation:'.length) : signal.inputRef;
      instant(signalAt, 'state.signal.inputRef');
      requireValue((!observation || signal.action === 'sell' || template.identity.id === 'wick-capture')
        && Date.parse(signalAt) + (observation ? 0 : 300_000) <= Date.parse(input.market.dataCutoff) && ['buy', 'sell', 'hold'].includes(signal.action)
        && ['no_action', 'pending_submission', 'acknowledged', 'rejected', 'uncertain'].includes(signal.disposition), 'state.signal', 'invalid_signal');
    }
    if (input.owned.quantity !== null) validateQuantity(input.owned.quantity, true);
    if (input.owned.quantity !== null && input.owned.quantity > 0) identifier(input.owned.positionKey, 'owned.positionKey');
    for (const at of [input.owned.entryAt, input.owned.firstFillAt]) if (at !== null) {
      instant(at, 'owned.fillAt'); requireValue(at <= input.evaluatedAt, 'owned.fillAt', 'future_fill');
    }
    for (const order of input.execution.workingOrders ?? []) {
      identifier(order.id, 'order.id'); instant(order.submittedAt, 'order.submittedAt');
      requireValue(['buy', 'sell'].includes(order.side) && typeof order.cancellationPending === 'boolean'
        && order.submittedAt <= input.evaluatedAt && (order.limitPriceUsd === null || positive(order.limitPriceUsd)), 'order', 'invalid_working_order');
    }
  } catch (error) {
    if (!(error instanceof DomainValidationError)) throw error;
    return blocked(input, veto('approval', error.code, error.message));
  }
  if (input.execution.uncertain || input.state.signal?.disposition === 'uncertain') return blocked(input, veto('execution', 'uncertain_execution', 'Reconcile the original submission before further decisions'));
  if (input.execution.pendingSubmission || input.state.signal?.disposition === 'pending_submission') return blocked(input, veto('execution', 'submission_pending', 'A candidate is awaiting submission reconciliation'));
  if (input.owned.quantity === null || input.execution.workingOrders === null) return blocked(input, veto('execution', 'reconciliation_required', 'Owned quantity and outstanding orders must be known'));
  const session = input.market.session;
  if (!session || !validSession(session) || session.calendarAsOf > input.market.dataCutoff || session.calendarId !== input.approved.plan.session.calendarId
    || session.tradingDate !== input.approved.plan.session.tradingDate || session.openAt !== input.approved.plan.session.openAt
    || session.closeAt !== input.approved.plan.session.closeAt) return blocked(input, veto('session', 'session_unavailable', 'A matching authoritative approved session is required'));
  return null;
}

export function quoteFresh(input: TemplateInput): boolean {
  const quote = input.market.quote;
  if (!quote || !positive(quote.priceUsd)) return false;
  try { instant(quote.at, 'quote.at'); } catch { return false; }
  return quote.at <= input.market.dataCutoff && Date.parse(input.evaluatedAt) - Date.parse(quote.at) <= QUOTE_MAX_AGE_MS
    && (input.state.positionKey !== input.owned.positionKey || !input.state.observedPeak || quote.at >= input.state.observedPeak.at);
}

export function entryBlocks(input: TemplateInput, bufferMinutes: number): readonly Veto[] {
  const blocks = [...input.execution.entryBlocks, ...input.approved.plan.blocks];
  const plan = input.approved.plan;
  if (!input.execution.entriesAllowed) blocks.push(veto('execution', 'entries_paused', 'New entries are paused by the caller'));
  if (input.evaluatedAt < plan.entryWindow.from || input.evaluatedAt >= plan.entryWindow.to
    || input.evaluatedAt >= plan.intendedEnd || Date.parse(plan.session.closeAt) - Date.parse(input.evaluatedAt) <= bufferMinutes * 60_000) {
    blocks.push(veto('session', 'entry_window_closed', 'The approved or template entry window is closed'));
  }
  return blocks;
}

export function sessionOpen(input: TemplateInput): boolean {
  return input.evaluatedAt >= input.approved.plan.session.openAt && input.evaluatedAt < input.approved.plan.session.closeAt;
}

/** Cancellation requests never remove orders or imply a terminal fill quantity. */
export function workingAndMarketGate(input: TemplateInput, bufferMinutes: number, state: TemplateState): TemplateResult | null {
  const bids = input.execution.workingOrders!.filter(order => order.side === 'buy');
  const blocks = entryBlocks(input, bufferMinutes);
  if (bids.length && (input.owned.quantity! > 0 || !sessionOpen(input) || !quoteFresh(input) || blocks.length)) {
    const ids = bids.filter(order => !order.cancellationPending).map(order => order.id);
    return result(input, ids.length ? 'cancel_entry' : 'cancellation_pending', state,
      ids.length ? { kind: 'cancel', orderIds: ids } : null, [], blocks);
  }
  if (!sessionOpen(input)) return blocked(input, veto('session', 'session_closed', 'Waiting for the approved trading session'), state);
  if (!quoteFresh(input)) return blocked(input, veto('data', 'stale_quote', 'A fresh observed price at or before the cutoff is required'), state);
  if (input.execution.workingOrders!.some(order => order.side === 'sell')) return result(input, 'exit_pending', state);
  return null;
}

export function positionState(input: TemplateInput): TemplateState {
  const key = input.owned.quantity! > 0 ? input.owned.positionKey : null;
  const samePosition = key !== null && key === input.state.positionKey;
  const firstFill = samePosition && input.state.firstFillAt && (!input.owned.firstFillAt || input.state.firstFillAt < input.owned.firstFillAt)
    ? input.state.firstFillAt : input.owned.firstFillAt;
  return { ...input.state, positionKey: key, observedPeak: samePosition ? input.state.observedPeak : null, firstFillAt: key === null ? null : firstFill };
}

export function exitIntent(input: TemplateInput): CandidateIntent {
  return { kind: 'exit', side: 'sell', quantity: input.owned.quantity!, orderType: 'market', limitPriceUsd: null };
}

export function entryIntent(input: TemplateInput, priceUsd: number, orderType: 'market' | 'limit'): CandidateIntent | null {
  // Preserve legacy whole-share sizing/cap; this is only a ceiling-sized candidate.
  // The coordinator must recheck current buying power, fees and all portfolio limits.
  const ceiling = input.approved.plan.capital.ceilingCents;
  // Avoid representing a huge uncapped fractional quantity for very cheap prices.
  // A full extra share of headroom keeps this shortcut away from rounding boundaries.
  const quantity = ceiling / 100 / priceUsd > 100_001 ? 100_000
    : Math.min(100_000, Math.floor(quantityWithinBudget(ceiling, priceUsd)));
  return quantity > 0 ? { kind: 'entry', side: 'buy', quantity, orderType, limitPriceUsd: orderType === 'limit' ? priceUsd : null } : null;
}
