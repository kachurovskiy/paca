import { evaluateObservedStops } from '../math/execution-policy';
import { inspectMomentum, MOMENTUM_BACKTEST_ASSUMPTIONS, tuneMomentum, type MomentumParameters } from '../math/momentum';
import { instant } from '../../core/validation';
import { validateParameters } from '../plan';
import { blocked, condition, discoveryEligibility, eligibility, entryBlocks, entryIntent, exitIntent, fullLegacySession, supportedTradingSession, positionState,
  positive, preflight, result, sessionDate, SUPPORT, veto, workingAndMarketGate } from './common';
import type { ResearchInput, ResearchResult, StrategyTemplate, TemplateInput, TemplateResult, TemplateState } from './types';

const identity = { id: 'trend-following', version: 1 } as const;
const diagnostics = ['warmup_bars', 'ema_fast_above_slow', 'ema_fast_rising', 'ema_slow_rising', 'close_above_fast', 'close_above_vwap', 'stop_loss', 'trailing_stop'] as const;

function evaluate(input: TemplateInput): TemplateResult {
  const invalid = preflight(trendFollowing, input);
  if (invalid) return invalid;
  let state = positionState(input);
  const marketGate = workingAndMarketGate(input, 5, state);
  if (marketGate) return marketGate;
  if (input.execution.workingOrders!.length) return result(input, 'entry_pending', state);
  const plan = input.approved.plan, quote = input.market.quote!, owned = input.owned.quantity!;
  const parameters: MomentumParameters = { fastPeriod: plan.parameters.fastPeriod, slowPeriod: plan.parameters.slowPeriod,
    stopLossPct: plan.parameters.stopLossPct, trailingStopPct: plan.parameters.trailingStopPct };
  // Preserve exit priority, including when history or fill cost is unavailable.
  if (owned > 0 && (input.evaluatedAt >= plan.intendedEnd
    || Date.parse(plan.session.closeAt) - Date.parse(input.evaluatedAt) <= 5 * 60_000)) {
    return result(input, 'session_exit', state, exitIntent(input));
  }
  if (owned > 0 && !positive(input.owned.averageEntryPriceUsd)) return blocked(input, veto('data', 'entry_cost_unavailable', 'Stops require attributable fill cost'), state);
  const stop = evaluateObservedStops(parameters, { hasPosition: owned > 0, entryPrice: input.owned.averageEntryPriceUsd ?? undefined,
    peakPrice: state.observedPeak?.priceUsd }, { time: Date.parse(quote.at), price: quote.priceUsd });
  state = { ...state, observedPeak: owned > 0 ? {
    priceUsd: stop.peakPrice,
    at: state.observedPeak?.priceUsd === stop.peakPrice ? state.observedPeak.at : quote.at,
  } : null };
  const ref = input.market.inputRef;
  const stopThreshold = owned > 0 ? input.owned.averageEntryPriceUsd! * (1 - parameters.stopLossPct / 100) : null;
  const trailThreshold = owned > 0 ? stop.peakPrice * (1 - parameters.trailingStopPct / 100) : null;
  const conditions = owned > 0 ? [
    condition('stop_loss', ref, quote.priceUsd, 'lte', stopThreshold!, quote.priceUsd <= stopThreshold!),
    condition('trailing_stop', ref, quote.priceUsd, 'lte', trailThreshold!, quote.priceUsd <= trailThreshold!),
  ] : [];
  if (stop.action === 'sell') return result(input, quote.priceUsd <= stopThreshold! ? 'stop_loss' : 'trailing_stop', state, exitIntent(input), conditions);
  if (owned > 0 && input.owned.entryAt === null) return blocked(input, veto('data', 'entry_time_unavailable', 'Gap detection requires an actual entry time'), state);
  const inspection = inspectMomentum(input.market.bars.map(bar => ({ ...bar })), parameters,
    { hasPosition: owned > 0, entryTime: input.owned.entryAt ?? undefined }, Date.parse(input.market.dataCutoff), plan.sessionMode === '24x5' ? plan.session : undefined);
  const { latest, indicators, signal } = inspection;
  if (!latest || !indicators || Date.parse(input.evaluatedAt) - Date.parse(latest.t) > 600_000) {
    conditions.push(condition('warmup_bars', ref, null, 'gte', parameters.slowPeriod + 2, false));
    return result(input, 'completed_bars_unavailable', state, null, conditions, [veto('data', 'completed_bars_unavailable', 'Fresh completed five-minute history is required')]);
  }
  conditions.push(
    condition('warmup_bars', latest.t, indicators.count, 'gte', parameters.slowPeriod + 2, indicators.count >= parameters.slowPeriod + 2),
    condition('ema_fast_above_slow', latest.t, indicators.fast, 'gt', indicators.slow, indicators.fast > indicators.slow),
    condition('ema_fast_rising', latest.t, indicators.fast, 'gt', indicators.previousFast, indicators.fast > indicators.previousFast),
    condition('ema_slow_rising', latest.t, indicators.slow, 'gt', indicators.previousSlow, indicators.slow > indicators.previousSlow),
    condition('close_above_fast', latest.t, latest.c, 'gt', indicators.fast, latest.c > indicators.fast),
    condition('close_above_vwap', latest.t, Number.isFinite(indicators.vwap) ? latest.c : null, 'gt', Number.isFinite(indicators.vwap) ? indicators.vwap : 'unavailable', latest.c > indicators.vwap),
  );
  const signalRef = new Date(Date.parse(latest.t)).toISOString();
  const prior = state.signal;
  if (prior?.inputRef === signalRef) return result(input, prior.disposition === 'rejected' ? 'signal_rejected' : 'signal_consumed', state, null, conditions);
  const signalState: NonNullable<TemplateState['signal']> = { inputRef: signalRef, action: signal.action,
    disposition: 'no_action' };
  state = { ...state, signal: signalState };
  if (signal.action === 'sell' && owned > 0) {
    state = { ...state, signal: { ...signalState, disposition: 'pending_submission' } };
    const reason = signal.reason.includes('gap') ? 'data_gap_exit' : signal.reason.includes('closes') ? 'session_exit' : 'trend_lost';
    return result(input, reason, state, exitIntent(input), conditions);
  }
  if (signal.action !== 'buy') {
    const reason = indicators.count < parameters.slowPeriod + 2 ? 'warmup_required' : signal.reason.includes('window') || signal.reason.includes('closes')
      ? 'entry_window_closed' : owned > 0 ? 'trend_intact' : 'trend_not_ready';
    return result(input, reason, state, null, conditions);
  }
  const blocks = [...entryBlocks(input, 5)];
  // Legacy research/signals use fixed full-session hours. Do not certify early-close entry behavior.
  if (!supportedTradingSession(plan.session)) blocks.push(veto('session', 'unsupported_short_session', 'Trend entries require the legacy 09:30–16:00 session; protective exits remain evaluable'));
  if (blocks.length) return result(input, blocks[0].code, state, null, conditions, blocks);
  const intent = entryIntent(input, positive(quote.askUsd) ? quote.askUsd : quote.priceUsd, 'market');
  if (intent) state = { ...state, signal: { ...signalState, disposition: 'pending_submission' } };
  return result(input, intent ? 'trend_entry' : 'capital_below_one_share', state, intent, conditions);
}

function research(input: ResearchInput): ResearchResult {
  try { instant(input.dataCutoff, 'research.dataCutoff'); }
  catch { return { status: 'unavailable', reasonCode: 'invalid_research_input', reason: 'A canonical UTC data cutoff is required' }; }
  const now = Date.parse(input.dataCutoff);
  if (!Number.isFinite(now) || !input.symbol.trim()) return { status: 'unavailable', reasonCode: 'invalid_research_input', reason: 'A symbol and explicit data cutoff are required' };
  if (!input.sessions.length || input.sessions.some(session => !fullLegacySession(session) || session.calendarAsOf > input.dataCutoff)
    || new Set(input.sessions.map(session => session.tradingDate)).size !== input.sessions.length
    || input.bars.some(bar => Number.isFinite(Date.parse(bar.t)) && !input.sessions.some(session => session.tradingDate === sessionDate(bar.t)))) {
    return { status: 'unavailable', reasonCode: 'unsupported_research_sessions', reason: 'Legacy Momentum research requires calendar coverage of full 09:30–16:00 sessions; shortened sessions are unsupported' };
  }
  return { status: 'experimental', report: tuneMomentum(input.symbol, input.bars.map(bar => ({ ...bar })), now), limitations: trendFollowing.simulationLimitations };
}

export const trendFollowing: StrategyTemplate = {
  identity, displayName: 'Trend Following', description: 'Existing completed-candle Momentum signals with observed-price stops.',
  parameters: {
    fastPeriod: { min: 2, max: 59, integer: true }, slowPeriod: { min: 3, max: 60, integer: true },
    // Legacy accepts every finite positive percentage through 5, not only tuner presets.
    stopLossPct: { min: Number.MIN_VALUE, max: 5, integer: false }, trailingStopPct: { min: Number.MIN_VALUE, max: 5, integer: false },
  },
  strictlyOrdered: [['fastPeriod', 'slowPeriod']], support: SUPPORT,
  requiredCapabilities: ['completed_5min_bars', 'observed_prices', 'market_orders', 'cancel_confirmation', 'owned_fills'],
  executionPolicy: { id: 'trend-observed-price', version: 1 }, exitPolicy: { id: 'trend-session-exit', version: 1 },
  diagnostics: { version: 1, conditionCodes: diagnostics }, researchSupport: 'experimental_legacy_momentum',
  simulationLimitations: [MOMENTUM_BACKTEST_ASSUMPTIONS, 'Existing selection is experimental evidence, not a validated badge or forecast.'],
  discoveryEligibility: input => [...discoveryEligibility(trendFollowing, input),
    ...(supportedTradingSession(input.session) ? [] : [veto('session', 'unsupported_short_session', 'Legacy Trend research requires a full 09:30 to 16:00 exchange session')])],
  validateParameters: value => validateParameters(value, trendFollowing), eligibility: input => eligibility(trendFollowing, input), evaluate, research,
};
