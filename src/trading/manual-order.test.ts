import { describe, expect, it } from 'vitest';
import type { Account, Position } from '../core/types';
import type { ExecutionQuote } from '../core/quote';
import { manualReviewKey, previewManual, suggestedManualLimit, type ManualOrder } from './manual-order';

const account: Account = { id: 'test', equity: 10_000, buyingPower: 10_000, cash: 10_000, lastEquity: 10_000, portfolioValue: 10_000, daytradeCount: 0, tradingBlocked: false, createdAt: null };
const quote: ExecutionQuote = { symbol: 'TEST', price: 100, bid: 99.99, ask: 100.01, tradeAt: 1, quoteAt: 1, receivedAt: 1, feed: 'sip' };
const position: Position = { symbol: 'TEST', qty: 10, side: 'long', avgEntryPrice: 90, currentPrice: 100, marketValue: 1000, unrealizedPl: 100, unrealizedPlpc: .1 };
const draft: ManualOrder = { symbol: 'TEST', side: 'buy', type: 'limit', quantity: 2, limitPrice: 100, extendedHours: false, timeInForce: 'day' };
const preview = (patch: Partial<ManualOrder>) => previewManual({ ...draft, ...patch }, account, position, quote, 10_000, 'paper');

describe('limit defaults and manual stops', () => {
  it.each([
    ['buy', { price: 100, bid: null, ask: 100.123 }, 100.13],
    ['sell', { price: 100, bid: 99.987, ask: null }, 99.98],
    ['buy', { price: 100.123, bid: 99, ask: null }, 100.13],
    ['sell', { price: .12345, bid: null, ask: null }, .1234],
    ['buy', { price: 100, bid: 102, ask: 101 }, 100],
    ['buy', { price: null, bid: null, ask: null }, null],
  ] as const)('prefills %s from the quote side or latest price', (side, value, expected) => {
    expect(suggestedManualLimit(side, value)).toBe(expected);
  });

  it.each(['day', 'gtc'] as const)('previews a protected %s buy and a standalone sell stop', timeInForce => {
    const buy = preview({ stopLossPrice: 95, timeInForce });
    expect(buy.error).toBeNull(); expect(buy.request).toMatchObject({ type: 'limit', qty: 2, limitPrice: 100, stopLoss: { stopPrice: 95 }, timeInForce });
    const sell = preview({ side: 'sell', type: 'stop', stopPrice: 95, timeInForce });
    expect(sell.error).toBeNull(); expect(sell.estimatedValue).toBe(190); expect(sell.positionAfter).toBe(8);
    expect(sell.request).toMatchObject({ type: 'stop', side: 'sell', stopPrice: 95, timeInForce });
    expect(sell.request).not.toHaveProperty('limitPrice'); expect(sell.request).not.toHaveProperty('stopLoss');
  });

  it.each([
    [{ stopLossPrice: 100 }, 'below the buy limit'],
    [{ limitPrice: 102, stopLossPrice: 100 }, 'below the current market price'],
    [{ stopLossPrice: 95.001 }, 'increments'],
    [{ stopLossPrice: 95, extendedHours: true }, 'regular hours'],
    [{ stopLossPrice: 95, quantity: .5 }, 'whole shares'],
    [{ side: 'sell', type: 'stop', stopPrice: 100 }, 'below the current market price'],
    [{ side: 'sell', type: 'stop', stopPrice: 95, extendedHours: true }, 'limit order'],
    [{ side: 'sell', type: 'stop', stopPrice: 95.001 }, 'increments'],
    [{ side: 'sell', type: 'stop', stopPrice: 95, quantity: 11 }, 'inventory'],
  ] as const)('blocks an unsupported stop before submission: %j', (patch, message) => {
    expect(preview(patch).error).toContain(message);
  });

  it('binds confirmations to the stop price and distinguishes a conditional full exit', () => {
    expect(manualReviewKey(preview({ stopLossPrice: 95 }))).not.toBe(manualReviewKey(preview({ stopLossPrice: 94 })));
    expect(preview({ side: 'sell', type: 'stop', stopPrice: 95, quantity: 10 }).confirmationReasons).toEqual(['This sells your entire holding if the stop triggers.']);
  });
});
