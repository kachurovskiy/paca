import { describe, expect, it } from 'vitest';
import { reconstructTrades } from './trades';
import type { TradeActivity } from '../core/types';

function fill(id: string, side: 'buy' | 'sell', qty: number, price: number, minute: number, orderId = id, symbol = 'AAPL'): TradeActivity {
  return { id, orderId, symbol, side, qty, price, transactionTime: `2026-09-17T14:${String(minute).padStart(2, '0')}:00Z`, type: 'fill' };
}

describe('trade history reconstruction', () => {
  it('combines partial buy fills and sell fills into one trade with weighted prices and realized P/L', () => {
    const { trades, realizedExits, unmatchedSellCount, unmatchedSellQty } = reconstructTrades([
      fill('buy-1', 'buy', 2, 100, 0, 'entry'),
      fill('buy-2', 'buy', 3, 110, 1, 'entry'),
      fill('sell-1', 'sell', 1, 120, 2, 'exit'),
      fill('sell-2', 'sell', 3, 130, 3, 'exit'),
    ]);
    expect(trades).toHaveLength(1);
    expect(trades[0]).toMatchObject({
      symbol: 'AAPL', buyOrderId: 'entry', qty: 5, soldQty: 4, openQty: 1,
      entryPrice: 106, exitPrice: 127.5, realizedCostBasis: 420,
      realizedPl: 90, openCostBasis: 110, closedAt: null,
      openedAt: '2026-09-17T14:00:00Z', lastActivityAt: '2026-09-17T14:03:00Z',
      lastSoldAt: '2026-09-17T14:03:00Z',
    });
    expect(unmatchedSellCount).toBe(0);
    expect(unmatchedSellQty).toBe(0);
    expect(realizedExits).toEqual([
      { id: 'sell-1', tradeId: trades[0].id, symbol: 'AAPL', soldAt: '2026-09-17T14:02:00Z', qty: 1, costBasis: 100, realizedPl: 20 },
      { id: 'sell-2', tradeId: trades[0].id, symbol: 'AAPL', soldAt: '2026-09-17T14:03:00Z', qty: 3, costBasis: 320, realizedPl: 70 },
    ]);
  });

  it('assembles simultaneous buys across orders into one trade per ticker while preserving FIFO costs', () => {
    const { trades, realizedExits } = reconstructTrades([
      fill('buy-a', 'buy', 2, 100, 0),
      fill('buy-b', 'buy', 3, 120, 0),
      fill('buy-other', 'buy', 1, 200, 0, 'buy-a', 'MSFT'),
      fill('sell', 'sell', 3, 130, 1),
    ]);

    expect(trades).toHaveLength(2);
    const trade = trades.find(trade => trade.symbol === 'AAPL')!;
    expect(trade).toMatchObject({
      buyOrderId: 'buy-a', qty: 5, soldQty: 3, openQty: 2,
      entryPrice: 112, exitPrice: 130, realizedCostBasis: 320,
      realizedPl: 70, openCostBasis: 240, closedAt: null,
    });
    expect(trades.find(trade => trade.symbol === 'MSFT')).toMatchObject({ qty: 1, openQty: 1, entryPrice: 200 });
    expect(realizedExits).toEqual([
      { id: 'sell', tradeId: trade.id, symbol: 'AAPL', soldAt: '2026-09-17T14:01:00Z', qty: 3, costBasis: 320, realizedPl: 70 },
    ]);
  });

  it('connects overlapping partial-order groups without changing earlier exits or FIFO lot order', () => {
    const { trades, realizedExits } = reconstructTrades([
      fill('entry-a1', 'buy', 1, 100, 0, 'entry-a'),
      fill('entry-b1', 'buy', 1, 200, 1, 'entry-b'),
      fill('exit-1', 'sell', 1, 150, 2),
      fill('entry-a2', 'buy', 1, 300, 3, 'entry-a'),
      fill('entry-b2', 'buy', 1, 400, 3, 'entry-b'),
      fill('entry-c', 'buy', 1, 500, 3, 'entry-c'),
      fill('exit-2', 'sell', 2.5, 450, 4),
    ]);

    expect(trades).toHaveLength(1);
    expect(trades[0]).toMatchObject({
      buyOrderId: 'entry-a', qty: 5, soldQty: 3.5, openQty: 1.5,
      entryPrice: 300, realizedCostBasis: 800, realizedPl: 475,
      openCostBasis: 700, closedAt: null, openedAt: '2026-09-17T14:00:00Z',
    });
    expect(trades[0].exitPrice).toBeCloseTo(1275 / 3.5);
    expect(realizedExits).toEqual([
      { id: 'exit-1', tradeId: trades[0].id, symbol: 'AAPL', soldAt: '2026-09-17T14:02:00Z', qty: 1, costBasis: 100, realizedPl: 50 },
      { id: 'exit-2', tradeId: trades[0].id, symbol: 'AAPL', soldAt: '2026-09-17T14:04:00Z', qty: 2.5, costBasis: 700, realizedPl: 425 },
    ]);
  });

  it('consumes the oldest buy fills across orders and keeps symbols independent', () => {
    const { trades, realizedExits } = reconstructTrades([
      fill('first', 'buy', 2, 100, 0),
      fill('second', 'buy', 3, 120, 1),
      fill('other', 'buy', 5, 200, 2, 'first', 'MSFT'),
      fill('exit', 'sell', 4, 110, 3),
    ]);
    const first = trades.find(trade => trade.symbol === 'AAPL' && trade.buyOrderId === 'first');
    const second = trades.find(trade => trade.buyOrderId === 'second');
    const other = trades.find(trade => trade.symbol === 'MSFT');
    expect(first).toMatchObject({ qty: 2, soldQty: 2, openQty: 0, realizedPl: 20, realizedCostBasis: 200, openCostBasis: 0, closedAt: '2026-09-17T14:03:00Z' });
    expect(second).toMatchObject({ qty: 3, soldQty: 2, openQty: 1, realizedPl: -20, realizedCostBasis: 240, openCostBasis: 120, closedAt: null });
    expect(other).toMatchObject({ qty: 5, soldQty: 0, openQty: 5, realizedPl: 0, exitPrice: null, lastSoldAt: null, openCostBasis: 1000 });
    expect(trades[trades.length - 1]).toBe(other);
    expect(realizedExits).toEqual([
      { id: 'exit', tradeId: first!.id, symbol: 'AAPL', soldAt: '2026-09-17T14:03:00Z', qty: 2, costBasis: 200, realizedPl: 20 },
      { id: 'exit', tradeId: second!.id, symbol: 'AAPL', soldAt: '2026-09-17T14:03:00Z', qty: 2, costBasis: 240, realizedPl: -20 },
    ]);
  });

  it('keeps FIFO lot costs when fills of the same order arrive around another order and sell', () => {
    const { trades } = reconstructTrades([
      fill('entry-a1', 'buy', 1, 100, 0, 'entry-a'),
      fill('entry-b', 'buy', 1, 200, 1, 'entry-b'),
      fill('exit-1', 'sell', 1, 150, 2),
      fill('entry-a2', 'buy', 2, 300, 3, 'entry-a'),
      fill('exit-2', 'sell', 1.5, 250, 4),
    ]);
    const a = trades.find(trade => trade.buyOrderId === 'entry-a')!;
    const b = trades.find(trade => trade.buyOrderId === 'entry-b')!;
    expect(a).toMatchObject({ qty: 3, soldQty: 1.5, openQty: 1.5, realizedCostBasis: 250, realizedPl: 25, openCostBasis: 450, closedAt: null });
    expect(a.entryPrice).toBeCloseTo(700 / 3);
    expect(a.exitPrice).toBeCloseTo(275 / 1.5);
    expect(b).toMatchObject({ soldQty: 1, openQty: 0, realizedCostBasis: 200, realizedPl: 50, openCostBasis: 0, closedAt: '2026-09-17T14:04:00Z' });
  });

  it('never assigns later buys to earlier sells and excludes the subsequent short cover', () => {
    const { trades, unmatchedSellQty, unmatchedSellCount } = reconstructTrades([
      fill('short', 'sell', 3, 100, 0),
      fill('cover-1', 'buy', 1, 90, 1),
      fill('cover-and-open', 'buy', 4, 80, 2),
      fill('long-exit', 'sell', 1, 85, 3),
    ]);
    expect(unmatchedSellQty).toBe(3);
    expect(unmatchedSellCount).toBe(1);
    expect(trades).toHaveLength(1);
    expect(trades[0]).toMatchObject({ buyOrderId: 'cover-and-open', qty: 2, soldQty: 1, openQty: 1, entryPrice: 80, exitPrice: 85, realizedPl: 5, openCostBasis: 80 });
    expect(reconstructTrades([fill('sell', 'sell', 1, 100, 0), fill('cover', 'buy', 1, 90, 1)]).trades).toEqual([]);
  });

  it('groups only the long portions of simultaneous buys after a short cover', () => {
    const { trades, unmatchedSellQty, unmatchedSellCount } = reconstructTrades([
      fill('short', 'sell', 3, 100, 0),
      fill('a-cover', 'buy', 2, 100, 1, 'cover-order'),
      fill('b-cover-and-open', 'buy', 2, 110, 1),
      fill('c-open', 'buy', 1, 120, 1),
      fill('exit', 'sell', 2, 130, 2),
      fill('later', 'buy', 1, 140, 3, 'cover-order'),
    ]);

    expect(unmatchedSellQty).toBe(3);
    expect(unmatchedSellCount).toBe(1);
    expect(trades).toHaveLength(2);
    expect(trades.find(trade => trade.buyOrderId === 'b-cover-and-open')).toMatchObject({
      qty: 2, soldQty: 2, openQty: 0, entryPrice: 115,
      realizedCostBasis: 230, realizedPl: 30, openCostBasis: 0,
      closedAt: '2026-09-17T14:02:00Z',
    });
    expect(trades.find(trade => trade.buyOrderId === 'cover-order')).toMatchObject({ qty: 1, entryPrice: 140, openedAt: '2026-09-17T14:03:00Z' });
  });

  it('reports only the unmatched portion of oversells and counts each unmatched fill once', () => {
    const { trades, unmatchedSellQty, unmatchedSellCount } = reconstructTrades([
      fill('buy', 'buy', 1, 100, 0),
      fill('sell-1', 'sell', 1.5, 120, 1),
      fill('sell-2', 'sell', 0.25, 130, 2),
    ]);
    expect(trades[0]).toMatchObject({ soldQty: 1, realizedPl: 20, exitPrice: 120, openQty: 0 });
    expect(unmatchedSellQty).toBe(0.75);
    expect(unmatchedSellCount).toBe(2);
  });

  it('closes fractional quantities without dust while retaining one-billionth shares', () => {
    const { trades, unmatchedSellQty } = reconstructTrades([
      fill('buy-1', 'buy', 0.1, 100, 0, 'entry'),
      fill('buy-2', 'buy', 0.2, 100, 1, 'entry'),
      fill('sell', 'sell', 0.3, 110, 2),
      fill('tiny-buy', 'buy', 0.000000003, 100, 3),
      fill('tiny-sell', 'sell', 0.000000002, 110, 4),
    ]);
    expect(trades.find(trade => trade.buyOrderId === 'entry')).toMatchObject({ qty: 0.3, openQty: 0, soldQty: 0.3, openCostBasis: 0, closedAt: '2026-09-17T14:02:00Z' });
    expect(trades.find(trade => trade.buyOrderId === 'tiny-buy')).toMatchObject({ qty: 0.000000003, openQty: 0.000000001, soldQty: 0.000000002, closedAt: null });
    expect(unmatchedSellQty).toBe(0);
  });

  it('deduplicates fills and produces the same result regardless of input order without mutating input', () => {
    const activities = [
      fill('a-buy', 'buy', 2, 100, 0),
      fill('b-buy', 'buy', 2, 200, 0),
      fill('c-sell', 'sell', 3, 150, 0),
      fill('later', 'buy', 1, 300, 1),
    ];
    const snapshot = structuredClone(activities);
    const expected = reconstructTrades(activities);
    expect(reconstructTrades([...activities].reverse().concat(activities[0], activities[2]))).toEqual(expected);
    expect(activities).toEqual(snapshot);
    expect(expected.trades[0].buyOrderId).toBe('later');
    expect(expected.trades).toHaveLength(2);
    expect(expected.trades.find(trade => trade.buyOrderId === 'a-buy')).toMatchObject({ qty: 4, soldQty: 3, openQty: 1, realizedPl: 50, realizedCostBasis: 400, openCostBasis: 200 });
  });

  it('groups equivalent instants across timestamp formats without rounding distinct nanosecond buys together', () => {
    const { trades } = reconstructTrades([
      { ...fill('buy-a', 'buy', 1, 100, 0), transactionTime: '2026-09-17T16:00:00.000100+02:00' },
      { ...fill('buy-b', 'buy', 1, 120, 0), transactionTime: '2026-09-17T14:00:00.000100000Z' },
      { ...fill('buy-c', 'buy', 1, 140, 0), transactionTime: '2026-09-17T14:00:00.000100001Z' },
      { ...fill('buy-d', 'buy', 1, 160, 0), transactionTime: '2026-09-17T14:00:00.000200Z' },
      { ...fill('buy-e', 'buy', 1, 180, 1), transactionTime: '2026-09-17T14:01:00Z' },
      { ...fill('buy-f', 'buy', 1, 200, 1), transactionTime: '2026-09-17T14:01:00.000000000Z' },
    ]);

    expect(trades).toHaveLength(4);
    expect(trades.find(trade => trade.buyOrderId === 'buy-a')).toMatchObject({ qty: 2, entryPrice: 110 });
    expect(trades.find(trade => trade.buyOrderId === 'buy-c')).toMatchObject({ qty: 1, entryPrice: 140 });
    expect(trades.find(trade => trade.buyOrderId === 'buy-d')).toMatchObject({ qty: 1, entryPrice: 160 });
    expect(trades.find(trade => trade.buyOrderId === 'buy-e')).toMatchObject({ qty: 2, entryPrice: 190 });
  });

  it('uses sub-millisecond timestamps before the ID tie break and compares timezone offsets correctly', () => {
    const buy = { ...fill('z-buy', 'buy', 1, 100, 0), transactionTime: '2026-09-17T16:00:00.000100+02:00' };
    const sell = { ...fill('a-sell', 'sell', 1, 110, 0), transactionTime: '2026-09-17T14:00:00.000200Z' };
    const result = reconstructTrades([sell, buy]);
    expect(result.unmatchedSellCount).toBe(0);
    expect(result.trades[0]).toMatchObject({ realizedPl: 10, openQty: 0, closedAt: sell.transactionTime });
  });

  it('returns no trades for an empty history', () => {
    expect(reconstructTrades([])).toEqual({ trades: [], realizedExits: [], unmatchedSellQty: 0, unmatchedSellCount: 0, excludedOptionCount: 0 });
  });

  it.each(['SPY260918C00600000', 'AAPL260918P00100000', 'AAPL1260918C00100000', 'AAPL  260918P00100000'])('excludes option contract %s instead of calculating P/L as shares', symbol => {
    const buy = fill('option-buy', 'buy', 1, 1, 0, 'option-entry', symbol);
    const sell = fill('option-sell', 'sell', 1, 2, 1, 'option-exit', symbol);

    expect(reconstructTrades([sell, buy, buy, sell])).toEqual({
      trades: [], realizedExits: [], unmatchedSellQty: 0, unmatchedSellCount: 0, excludedOptionCount: 2,
    });
  });

  it('keeps option fills out of mixed history totals while preserving equity and crypto quantities', () => {
    const { trades, excludedOptionCount, unmatchedSellCount } = reconstructTrades([
      fill('stock-buy', 'buy', 2, 100, 0, 'stock-entry', 'BRK.B'),
      fill('stock-sell', 'sell', 1, 110, 1, 'stock-exit', 'BRK.B'),
      fill('option-buy', 'buy', 1, 1, 2, 'option-entry', 'SPY260918C00600000'),
      fill('option-sell', 'sell', 1, 2, 3, 'option-exit', 'SPY260918C00600000'),
      fill('crypto-buy', 'buy', 0.5, 10000, 4, 'crypto-entry', 'BTC/USD'),
      fill('crypto-sell', 'sell', 0.5, 12000, 5, 'crypto-exit', 'BTC/USD'),
    ]);

    expect(excludedOptionCount).toBe(2);
    expect(unmatchedSellCount).toBe(0);
    expect(trades).toHaveLength(2);
    expect(trades.find(trade => trade.symbol === 'BRK.B')).toMatchObject({ realizedPl: 10, openQty: 1, openCostBasis: 100 });
    expect(trades.find(trade => trade.symbol === 'BTC/USD')).toMatchObject({ realizedPl: 1000, openQty: 0, qty: 0.5 });
    expect(trades.reduce((sum, trade) => sum + trade.realizedPl, 0)).toBe(1010);
  });
});
