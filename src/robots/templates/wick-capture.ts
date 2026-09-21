import { wickLimitPrice } from '../math/wick';
import { validateParameters } from '../plan';
import { blocked, condition, discoveryEligibility, eligibility, entryBlocks, entryIntent, exitIntent, positionState, positive, preflight, result, SUPPORT, veto, workingAndMarketGate } from './common';
import type { StrategyTemplate, TemplateInput, TemplateResult } from './types';

function evaluate(input: TemplateInput): TemplateResult {
  const invalid = preflight(wickCapture, input);
  if (invalid) return invalid;
  const state = positionState(input), plan = input.approved.plan;
  const { holdMinutes, dipPct } = plan.parameters;
  const marketGate = workingAndMarketGate(input, Math.max(holdMinutes, 5), state);
  if (marketGate) return marketGate;
  const now = Date.parse(input.evaluatedAt), quote = input.market.quote!, ref = input.market.inputRef;
  if (input.owned.quantity! > 0) {
    if (input.evaluatedAt >= plan.intendedEnd || Date.parse(plan.session.closeAt) - now <= 60_000) return result(input, 'session_exit', state, exitIntent(input));
    const due = state.firstFillAt === null ? null : Date.parse(state.firstFillAt) + holdMinutes * 60_000;
    const conditions = [condition('holding_deadline', ref, due === null ? null : now, 'gte', due ?? 'unavailable', due !== null && now >= due)];
    if (due === null) return result(input, 'first_fill_unavailable', state, null, conditions,
      [veto('data', 'first_fill_unavailable', 'The holding clock requires the first actual attributable fill, never submission or final completion time')]);
    return result(input, now >= due ? 'holding_time_exit' : 'holding_fill', state, now >= due ? exitIntent(input) : null, conditions);
  }
  const price = wickLimitPrice(quote.bidUsd ?? 0, dipPct);
  const conditions = [condition('bid_below_market', ref, positive(price) ? price : null, 'lt', quote.bidUsd ?? 'unavailable', price < (quote.bidUsd ?? 0))];
  const bid = input.execution.workingOrders!.find(order => order.side === 'buy');
  if (bid) {
    if (bid.cancellationPending) return result(input, 'cancellation_pending', state, null, conditions);
    const elapsed = now - Date.parse(bid.submittedAt);
    const movement = positive(bid.limitPriceUsd) && positive(price) ? Math.abs(price / bid.limitPriceUsd - 1) : null;
    const change = movement !== null && Number.isFinite(movement) ? movement : null;
    conditions.push(condition('reprice_age_ms', ref, elapsed, 'gte', 60_000, elapsed >= 60_000),
      condition('reprice_fraction', ref, change, 'gte', 0.0015, change !== null && change >= 0.0015));
    if (elapsed >= 60_000 && change !== null && change >= 0.0015) return result(input, 'reprice_cancel', state, { kind: 'cancel', orderIds: [bid.id] }, conditions);
    return result(input, 'resting_bid', state, null, conditions);
  }
  const blocks = entryBlocks(input, Math.max(holdMinutes, 5));
  if (blocks.length) return result(input, blocks[0].code, state, null, conditions, blocks);
  if (!positive(price) || !positive(quote.bidUsd) || !positive(quote.askUsd) || quote.bidUsd > quote.askUsd) return blocked(input, veto('data', 'invalid_bid_ask', 'A positive uncrossed bid and ask with a finite limit price are required'), state);
  const intent = entryIntent(input, price, 'limit');
  return result(input, intent ? 'wick_entry' : 'capital_below_one_share', state, intent, conditions);
}

export const wickCapture: StrategyTemplate = {
  identity: { id: 'wick-capture', version: 1 }, displayName: 'Wick Capture',
  description: 'Existing below-bid limit entry with a holding clock anchored to the first actual fill.',
  parameters: { dipPct: { min: 0.1, max: 20, integer: false }, holdMinutes: { min: 1, max: 120, integer: true } },
  strictlyOrdered: [], support: SUPPORT,
  requiredCapabilities: ['observed_prices', 'bid_ask', 'market_orders', 'limit_orders', 'cancel_confirmation', 'owned_fills', 'first_fill_activities'],
  executionPolicy: { id: 'wick-cancel-before-reprice', version: 1 }, exitPolicy: { id: 'wick-first-fill-clock', version: 1 },
  diagnostics: { version: 1, conditionCodes: ['bid_below_market', 'reprice_age_ms', 'reprice_fraction', 'holding_deadline'] },
  researchSupport: 'unavailable', simulationLimitations: ['No Wick research simulator exists. Bars cannot establish limit fills, queue position, or first-fill timing.'],
  discoveryEligibility: input => discoveryEligibility(wickCapture, input),
  validateParameters: value => validateParameters(value, wickCapture), eligibility: input => eligibility(wickCapture, input), evaluate,
  research: () => ({ status: 'unavailable', reasonCode: 'wick_research_unavailable', reason: 'No existing Wick research or fill simulator is available' }),
};
