import type { Bar } from '../../core/types';
import { instant } from '../../core/validation';
import type { RobotSession } from '../domain';
import { validateParameters } from '../plan';
import {
blocked,condition,discoveryEligibility,eligibility,entryBlocks,entryIntent,exitIntent,positionState,
positive,preflight,result,
SUPPORT,
veto,workingAndMarketGate
} from './common';
import type { StrategyTemplate, TemplateInput, TemplateResult } from './types';

export const VWAP_POLICY = Object.freeze({ intervalMs: 300_000, maximumBars: 78, maximumSpreadPct: 0.25,
  minimumVolatilityPct: 0.02, maximumDeviationPct: 3, exitBufferMinutes: 5 });
export const VWAP_DEFAULTS = Object.freeze({ warmupBars: 6, entryDeviationPct: 0.5, stopLossPct: 1, holdMinutes: 20,
  maxTrendPct: 1.5, maxVolatilityPct: 1, minSessionDollarVolume: 1_000_000 });
export type VwapParameters = { [K in keyof typeof VWAP_DEFAULTS]: number };
export interface VwapStatistics {
  readonly count: number; readonly latestAt: string; readonly vwap: number; readonly sessionDollars: number;
  readonly trendPct: number; readonly volatilityPct: number;
}
export type VwapInspection = { readonly status: 'available'; readonly statistics: VwapStatistics }
  | { readonly status: 'unavailable'; readonly reason: string };

/** Session-only HLC3 * volume / volume. This bar-derived approximation is not tick VWAP.
 * Read timestamps before any values: incomplete/future and other-session prices are never accessed. */
export function inspectSessionVwap(bars: readonly Readonly<Bar>[], session: RobotSession, cutoff: string): VwapInspection {
  const unavailable = (reason: string): VwapInspection => ({ status: 'unavailable', reason });
  try { instant(cutoff, 'vwap.cutoff'); instant(session.openAt, 'vwap.open'); instant(session.closeAt, 'vwap.close'); }
  catch { return unavailable('invalid_vwap_clock'); }
  const at = Date.parse(cutoff), open = Date.parse(session.openAt), close = Date.parse(session.closeAt), interval = VWAP_POLICY.intervalMs;
  if (at < open || at > close) return unavailable('vwap_session_unavailable');
  const completed: Readonly<Bar>[] = [];
  for (const bar of bars) {
    const time = Date.parse(bar.t);
    if (!Number.isFinite(time)) return unavailable('invalid_bar_time');
    if (time < open || time >= close || time + interval > at || time + interval > close) continue;
    completed.push(bar);
  }
  completed.sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
  if (!completed.length || completed.length > Math.max(VWAP_POLICY.maximumBars, (close - open) / interval)) return unavailable('session_bars_unavailable');
  let volume = 0, dollars = 0, squares = 0;
  for (const [index, bar] of completed.entries()) {
    if (Date.parse(bar.t) !== open + index * interval) return unavailable('incomplete_session_history');
    if (![bar.o, bar.h, bar.l, bar.c, bar.v].every(v => Number.isFinite(v) && v > 0)
      || bar.h < Math.max(bar.o, bar.c) || bar.l > Math.min(bar.o, bar.c)) return unavailable('invalid_price_or_volume');
    volume += bar.v; dollars += ((bar.h + bar.l + bar.c) / 3) * bar.v;
    if (index) squares += ((bar.c / completed[index - 1].c - 1) * 100) ** 2;
  }
  const last = completed[completed.length - 1];
  if (at - Date.parse(last.t) > interval * 2) return unavailable('stale_completed_bars');
  const vwap = dollars / volume, trendPct = Math.abs((last.c / completed[0].c - 1) * 100);
  const volatilityPct = Math.sqrt(squares / Math.max(1, completed.length - 1));
  if (![vwap, dollars, trendPct, volatilityPct].every(Number.isFinite) || vwap <= 0) return unavailable('invalid_vwap_totals');
  return { status: 'available', statistics: { count: completed.length, latestAt: new Date(Date.parse(last.t)).toISOString(),
    vwap, sessionDollars: dollars, trendPct, volatilityPct } };
}

function evaluate(input: TemplateInput): TemplateResult {
  const invalid = preflight(vwapMeanReversion, input); if (invalid) return invalid;
  let state = positionState(input);
  const plan = input.approved.plan, p = plan.parameters as VwapParameters, owned = input.owned.quantity!;
  if (state.signal && state.signal.inputRef.replace('observation:', '') < plan.session.openAt) state = { ...state, signal: null };
  const gate = workingAndMarketGate(input, VWAP_POLICY.exitBufferMinutes, state); if (gate) return gate;
  if (input.execution.workingOrders!.length) return result(input, 'entry_pending', state);
  const quote = input.market.quote!, ref = input.market.inputRef;
  // Protective exits do not depend on a reconstructed mean or complete bar history.
  if (owned > 0 && (input.evaluatedAt >= plan.intendedEnd
    || Date.parse(plan.session.closeAt) - Date.parse(input.evaluatedAt) <= VWAP_POLICY.exitBufferMinutes * 60_000))
    return result(input, 'session_exit', state, exitIntent(input));
  if (owned > 0 && state.firstFillAt && Date.parse(input.evaluatedAt) - Date.parse(state.firstFillAt) >= p.holdMinutes * 60_000)
    return result(input, 'holding_deadline', state, exitIntent(input),
      [condition('holding_minutes', ref, (Date.parse(input.evaluatedAt) - Date.parse(state.firstFillAt)) / 60_000, 'gte', p.holdMinutes, true)]);
  if (owned > 0 && !positive(input.owned.averageEntryPriceUsd)) return blocked(input, veto('data', 'entry_cost_unavailable', 'The stop requires attributable entry cost'), state);
  const stopPrice = owned > 0 ? input.owned.averageEntryPriceUsd! * (1 - p.stopLossPct / 100) : null;
  const conditions = stopPrice === null ? [] : [condition('stop_loss', ref, quote.priceUsd, 'lte', stopPrice, quote.priceUsd <= stopPrice)];
  if (stopPrice !== null && quote.priceUsd <= stopPrice) return result(input, 'stop_loss', state, exitIntent(input), conditions);
  if (owned > 0 && !state.firstFillAt) return blocked(input, veto('data', 'first_fill_time_unavailable', 'Holding time requires an actual first-fill observation'), state);
  const inspection = inspectSessionVwap(input.market.bars, plan.session, input.market.dataCutoff);
  if (inspection.status !== 'available') return result(input, inspection.reason, state, null, conditions,
    [veto('data', inspection.reason, 'Complete positive-volume five-minute bars from this session open are required; missing data is not reconstructed')]);
  const s = inspection.statistics, ask = positive(quote.askUsd) ? quote.askUsd : null;
  const spread = ask !== null && positive(quote.bidUsd) && ask >= quote.bidUsd ? (ask / quote.bidUsd - 1) * 100 : null;
  const deviation = ask === null ? null : (1 - ask / s.vwap) * 100;
  conditions.push(condition('session_vwap', s.latestAt, s.vwap, 'gt', 0, true),
    condition('warmup_bars', s.latestAt, s.count, 'gte', p.warmupBars, s.count >= p.warmupBars),
    condition('entry_deviation_pct', s.latestAt, deviation, 'gte', p.entryDeviationPct, deviation !== null && deviation >= p.entryDeviationPct),
    condition('maximum_deviation_pct', s.latestAt, deviation, 'lte', VWAP_POLICY.maximumDeviationPct, deviation !== null && deviation <= VWAP_POLICY.maximumDeviationPct),
    condition('trend_magnitude_pct', s.latestAt, s.trendPct, 'lte', p.maxTrendPct, s.trendPct <= p.maxTrendPct),
    condition('minimum_volatility_pct', s.latestAt, s.volatilityPct, 'gte', VWAP_POLICY.minimumVolatilityPct, s.volatilityPct >= VWAP_POLICY.minimumVolatilityPct),
    condition('maximum_volatility_pct', s.latestAt, s.volatilityPct, 'lte', p.maxVolatilityPct, s.volatilityPct <= p.maxVolatilityPct),
    condition('session_dollar_volume', s.latestAt, s.sessionDollars, 'gte', p.minSessionDollarVolume, s.sessionDollars >= p.minSessionDollarVolume),
    condition('spread_pct', ref, spread, 'lte', VWAP_POLICY.maximumSpreadPct, spread !== null && spread <= VWAP_POLICY.maximumSpreadPct));
  if (owned > 0) {
    const target = positive(quote.bidUsd) && quote.bidUsd >= s.vwap;
    conditions.push(condition('mean_exit', ref, quote.bidUsd, 'gte', s.vwap, target));
    return result(input, target ? 'mean_reversion_exit' : 'waiting_for_mean', state, target ? exitIntent(input) : null, conditions);
  }
  const prior = state.signal;
  if (prior?.inputRef === s.latestAt) return result(input, 'signal_consumed', state, null, conditions);
  const entry = conditions.every(c => c.result === 'pass');
  state = { ...state, signal: { inputRef: s.latestAt, action: entry ? 'buy' : 'hold', disposition: 'no_action' } };
  const blocks = entryBlocks(input, VWAP_POLICY.exitBufferMinutes);
  if (blocks.length) return result(input, blocks[0].code, state, null, conditions, blocks);
  if (!entry) return result(input, s.count < p.warmupBars ? 'warmup_required' : 'mean_reversion_filters', state, null, conditions);
  const intent = entryIntent(input, ask!, 'market');
  if (intent) state = { ...state, signal: { ...state.signal!, disposition: 'pending_submission' } };
  return result(input, intent ? 'mean_reversion_entry' : 'capital_below_one_share', state, intent, conditions);
}

export const vwapMeanReversion: StrategyTemplate = {
  identity: { id: 'vwap-mean-reversion', version: 1 }, displayName: 'VWAP Mean Reversion',
  description: 'Bounded long-only entry below the current session volume-weighted typical bar price, with observed exits.',
  parameters: { warmupBars: { min: 6, max: 24, integer: true }, entryDeviationPct: { min: 0.25, max: 1.5, integer: false },
    stopLossPct: { min: 0.25, max: 3, integer: false }, holdMinutes: { min: 5, max: 60, integer: true },
    maxTrendPct: { min: 0.5, max: 3, integer: false }, maxVolatilityPct: { min: 0.25, max: 3, integer: false },
    minSessionDollarVolume: { min: 100_000, max: 100_000_000, integer: true } },
  strictlyOrdered: [], support: SUPPORT,
  requiredCapabilities: ['completed_5min_bars', 'observed_prices', 'bid_ask', 'market_orders', 'cancel_confirmation', 'owned_fills', 'first_fill_activities'],
  executionPolicy: { id: 'vwap-observed-price', version: 1 }, exitPolicy: { id: 'vwap-mean-stop-time-session', version: 1 },
  diagnostics: { version: 1, conditionCodes: ['session_vwap', 'warmup_bars', 'entry_deviation_pct', 'maximum_deviation_pct', 'trend_magnitude_pct',
    'minimum_volatility_pct', 'maximum_volatility_pct', 'session_dollar_volume', 'spread_pct', 'mean_exit', 'stop_loss', 'holding_minutes'],
    presentation: { title: 'Session VWAP, deviation and entry filters',
      description: 'Recorded completed-bar VWAP, deviation and filter observations stay tied to their original cutoff. Holding time uses the first attributable fill.',
      labels: { session_vwap: 'Session VWAP (HLC3, USD)', entry_deviation_pct: 'Entry deviation below VWAP (%)',
        maximum_deviation_pct: 'Maximum deviation (%)', trend_magnitude_pct: 'Session trend magnitude (%)',
        minimum_volatility_pct: 'Minimum RMS volatility (%)', maximum_volatility_pct: 'Maximum RMS volatility (%)',
        session_dollar_volume: 'Observed session dollar volume (USD)', spread_pct: 'Observed spread (%)',
        mean_exit: 'Observed bid reaches session VWAP', holding_minutes: 'Minutes since first fill' },
      levels: [{ code: 'session_vwap', field: 'observed', label: 'Session VWAP' },
        { code: 'mean_exit', field: 'threshold', label: 'Observed mean exit' }, { code: 'stop_loss', field: 'threshold', label: 'Observed stop' }] } },
  researchSupport: 'unavailable',
  simulationLimitations: ['Experimental design choices; no profitability or calibrated forecast evidence.',
    'Session mean uses HLC3 weighted by observed completed-bar volume, not tick-level execution VWAP. No missing prices or volumes are inferred.',
    'RMS close returns and first-to-last close drift are bounded regime filters, not forecasts.',
    'Observed stops, holding deadlines and session exits require browser/broker availability and do not guarantee losses or execution prices.',
    'Paper admission requires the retained independent chronological experiment to pass all common evidence gates.'],
  validateParameters: value => validateParameters(value, vwapMeanReversion),
  discoveryEligibility: input => discoveryEligibility(vwapMeanReversion, input), eligibility: input => eligibility(vwapMeanReversion, input), evaluate,
  research: () => ({ status: 'unavailable', reasonCode: 'chronological_experiment_required', reason: 'Use the independent bounded scheduler and retained exposure journal; a bare bar list cannot establish chronological qualification.' }),
};
