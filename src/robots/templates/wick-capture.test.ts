import { describe, expect, it } from 'vitest';
import { wickLimitPrice as legacyLimitPrice } from '../math/wick';
import { inputFixture, iso, NOW, observe, own } from './test-fixtures';
import { wickCapture } from './wick-capture';

describe('Wick Capture characterization', () => {
  it.each([{ bid: 100, dip: 0.6 }, { bid: 0.75, dip: 0.1 }, { bid: 50.123, dip: 20 }])('preserves legacy price ticks and whole-share sizing: %j', ({ bid, dip }) => {
    const input = inputFixture(wickCapture); observe(input, NOW, bid); input.approved.plan.parameters.dipPct = dip;
    const evaluated = wickCapture.evaluate(input), price = legacyLimitPrice(bid, dip);
    expect(evaluated.intent).toEqual({ kind: 'entry', side: 'buy', orderType: 'limit', limitPriceUsd: price,
      quantity: Math.min(100_000, Math.floor(input.approved.plan.capital.ceilingCents / 100 / price)) });
    expect(input.owned.firstFillAt).toBeNull(); expect(evaluated.state.firstFillAt).toBeNull();
  });

  it('does not start a holding clock while a bid waits twenty minutes for its first fill', () => {
    const input = inputFixture(wickCapture);
    input.execution.workingOrders = [{ id: 'bid-1', side: 'buy', cancellationPending: false, limitPriceUsd: legacyLimitPrice(106, 0.6), submittedAt: iso(NOW) }];
    observe(input, NOW + 20 * 60_000);
    expect(wickCapture.evaluate(input)).toMatchObject({ intent: null, state: { firstFillAt: null }, decision: { reasonCode: 'resting_bid' } });
    input.execution.workingOrders = []; own(input, 2, 105, NOW + 20 * 60_000);
    input.state = wickCapture.evaluate(input).state;
    observe(input, NOW + 25 * 60_000 - 1);
    expect(wickCapture.evaluate(input).decision.reasonCode).toBe('holding_fill');
    observe(input, NOW + 25 * 60_000);
    expect(wickCapture.evaluate(input)).toMatchObject({ intent: { side: 'sell', quantity: 2 }, decision: { reasonCode: 'holding_time_exit' } });
  });

  it('cancels residual bids, waits for confirmation, includes racing fills and retains the earliest clock', () => {
    const input = inputFixture(wickCapture); observe(input, NOW + 60_000); own(input, 0.5, 105, NOW + 60_000);
    input.execution.workingOrders = [{ id: 'bid-1', side: 'buy', cancellationPending: false, limitPriceUsd: 105, submittedAt: iso(NOW) }];
    const cancel = wickCapture.evaluate(input);
    expect(cancel.intent).toEqual({ kind: 'cancel', orderIds: ['bid-1'] });
    input.state = cancel.state;
    input.execution.workingOrders[0].cancellationPending = true;
    input.owned.quantity = 0.75; input.owned.firstFillAt = iso(NOW + 4 * 60_000);
    observe(input, NOW + 6 * 60_000);
    const waiting = wickCapture.evaluate(input);
    expect(waiting.intent).toBeNull(); expect(waiting.state.firstFillAt).toBe(iso(NOW + 60_000));
    input.state = waiting.state;
    // Only a reconciled terminal cancellation removes the residual order.
    input.execution.workingOrders = [];
    expect(wickCapture.evaluate(input)).toMatchObject({ intent: { kind: 'exit', quantity: 0.75 }, decision: { reasonCode: 'holding_time_exit' } });
  });

  it('never substitutes entry/completion time for missing first-fill evidence, but can still cancel and exit near close', () => {
    const input = inputFixture(wickCapture); own(input); input.owned.firstFillAt = null;
    observe(input, NOW + 30 * 60_000);
    const missing = wickCapture.evaluate(input);
    expect(missing).toMatchObject({ intent: null, state: { firstFillAt: null }, decision: { reasonCode: 'first_fill_unavailable' } });
    expect(missing.decision.conditions[0]).toMatchObject({ result: 'unavailable', observed: null });
    input.execution.workingOrders = [{ id: 'residual', side: 'buy', cancellationPending: false, limitPriceUsd: 100, submittedAt: iso(NOW) }];
    expect(wickCapture.evaluate(input).intent?.kind).toBe('cancel');
    input.execution.workingOrders = [];
    observe(input, Date.parse(input.approved.plan.intendedEnd));
    expect(wickCapture.evaluate(input)).toMatchObject({ intent: { quantity: 2 }, decision: { reasonCode: 'session_exit' } });
  });

  it('waits one minute and 0.15% movement before canceling to reprice, then requires confirmed cancellation', () => {
    const input = inputFixture(wickCapture);
    input.execution.workingOrders = [{ id: 'bid-1', side: 'buy', cancellationPending: false, limitPriceUsd: legacyLimitPrice(106, 0.6), submittedAt: iso(NOW) }];
    observe(input, NOW + 59_999, 108);
    expect(wickCapture.evaluate(input).decision.reasonCode).toBe('resting_bid');
    observe(input, NOW + 60_000, 106.01);
    expect(wickCapture.evaluate(input).decision.reasonCode).toBe('resting_bid');
    observe(input, NOW + 60_000, 108);
    expect(wickCapture.evaluate(input)).toMatchObject({ intent: { kind: 'cancel' }, decision: { reasonCode: 'reprice_cancel' } });
    input.execution.workingOrders[0].cancellationPending = true;
    expect(wickCapture.evaluate(input).decision.reasonCode).toBe('cancellation_pending');
    input.execution.workingOrders = [];
    expect(wickCapture.evaluate(input).intent).toMatchObject({ kind: 'entry', limitPriceUsd: legacyLimitPrice(108, 0.6) });
  });

  it('clears the first-fill clock for a new round trip and preserves fractional remaining inventory', () => {
    const input = inputFixture(wickCapture); own(input, 0.000000001);
    input.state = wickCapture.evaluate(input).state;
    observe(input, NOW + 6 * 60_000);
    expect(wickCapture.evaluate(input).intent).toMatchObject({ quantity: 0.000000001 });
    own(input, 1, 106, NOW + 6 * 60_000, 'next-round-trip'); input.owned.firstFillAt = null;
    expect(wickCapture.evaluate(input)).toMatchObject({ intent: null, state: { firstFillAt: null }, decision: { reasonCode: 'first_fill_unavailable' } });
  });

  it('uses approved shortened-session boundaries and refuses entries without time for the holding period', () => {
    const input = inputFixture(wickCapture);
    input.approved.plan.session.closeAt = '2026-09-18T17:00:00.000Z'; input.approved.plan.intendedEnd = '2026-09-18T16:59:00.000Z';
    input.approved.plan.entryWindow.to = '2026-09-18T16:58:00.000Z'; input.market.session = { ...input.approved.plan.session };
    expect(wickCapture.evaluate(input).intent?.kind).toBe('entry');
    observe(input, Date.parse('2026-09-18T16:55:00.000Z'));
    expect(wickCapture.evaluate(input).decision.reasonCode).toBe('entry_window_closed');
    own(input); input.owned.firstFillAt = null; observe(input, Date.parse('2026-09-18T16:59:00.000Z'));
    expect(wickCapture.evaluate(input).decision.reasonCode).toBe('session_exit');
  });

  it.each([null, 0, NaN, -1, 105])('refuses an unavailable or crossed ask: %s', ask => {
    const input = inputFixture(wickCapture); input.market.quote!.askUsd = ask;
    expect(wickCapture.evaluate(input).decision.reasonCode).toBe('invalid_bid_ask');
  });

  it('reports unavailable research without inventing fills or forecasts', () => {
    const input = inputFixture(wickCapture);
    expect(wickCapture.research({ symbol: 'TEST', bars: input.market.bars, dataCutoff: input.market.dataCutoff, sessions: [input.market.session!] }))
      .toMatchObject({ status: 'unavailable', reasonCode: 'wick_research_unavailable' });
  });

  it('blocks a non-finite derived limit rather than propagating legacy rounding overflow', () => {
    const input = inputFixture(wickCapture); observe(input, NOW, Number.MAX_VALUE);
    expect(wickCapture.evaluate(input)).toMatchObject({ intent: null, decision: { reasonCode: 'invalid_bid_ask' } });
    input.execution.workingOrders = [{ id: 'bid', side: 'buy', cancellationPending: false, limitPriceUsd: 100, submittedAt: iso(NOW - 60_000) }];
    const waiting = wickCapture.evaluate(input);
    expect(waiting.intent).toBeNull(); expect(waiting.decision.conditions.find(item => item.code === 'reprice_fraction')).toMatchObject({ observed: null, result: 'unavailable' });
  });

  
});
