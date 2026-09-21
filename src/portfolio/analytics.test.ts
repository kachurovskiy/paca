import { describe, expect, it } from 'vitest';
import { aggregateTradeHistory } from './analytics';
import { reconstructTrades } from './trades';
import type { TradeActivity } from '../core/types';

function fill(id: string, side: 'buy' | 'sell', qty: number, price: number, transactionTime: string, orderId = id, symbol = 'AAPL'): TradeActivity {
  return { id, orderId, symbol, side, qty, price, transactionTime, type: 'fill' };
}

describe('trade history analytics', () => {
  it('attributes partial exits to their sell dates and trade outcomes to the final close month', () => {
    const history = reconstructTrades([
      fill('buy', 'buy', 4, 100, '2026-01-02T15:00:00Z'),
      fill('first-exit', 'sell', 1, 110, '2026-01-05T15:00:00Z'),
      fill('second-exit', 'sell', 1, 95, '2026-01-06T15:00:00Z'),
      fill('final-exit', 'sell', 2, 120, '2026-02-02T15:00:00Z'),
      fill('open-buy', 'buy', 3, 50, '2026-02-03T15:00:00Z'),
      fill('partial-open-exit', 'sell', 1, 60, '2026-02-04T15:00:00Z'),
    ]);
    const summary = aggregateTradeHistory(history, 'America/New_York');
    expect(summary.days).toEqual([
      { date: '2026-01-05', realizedPl: 10, exits: 1 },
      { date: '2026-01-06', realizedPl: -5, exits: 1 },
      { date: '2026-02-02', realizedPl: 40, exits: 1 },
      { date: '2026-02-04', realizedPl: 10, exits: 1 },
    ]);
    expect(summary.months).toEqual([
      { month: '2026-02', realizedPl: 50, closedTrades: 1, wins: 1, losses: 0, breakeven: 0, winRate: 100, profitFactor: null, averageTrade: 45, bestDay: 40, worstDay: 10, activeDays: 2 },
      { month: '2026-01', realizedPl: 5, closedTrades: 0, wins: 0, losses: 0, breakeven: 0, winRate: null, profitFactor: null, averageTrade: null, bestDay: 10, worstDay: -5, activeDays: 2 },
    ]);
    expect(summary.days.reduce((sum, day) => sum + day.realizedPl, 0)).toBe(history.trades.reduce((sum, trade) => sum + trade.realizedPl, 0));
  });

  it('counts each closed buy-order trade once, includes flat trades in win rate, and calculates profit factor from trade outcomes', () => {
    const history = reconstructTrades([
      fill('winner-buy', 'buy', 2, 100, '2026-05-01T15:00:00Z'),
      fill('winner-sell-a', 'sell', 1, 95, '2026-05-04T15:00:00Z'),
      fill('winner-sell-b', 'sell', 1, 125, '2026-05-04T16:00:00Z'),
      fill('loser-buy', 'buy', 1, 100, '2026-05-05T15:00:00Z'),
      fill('loser-sell', 'sell', 1, 90, '2026-05-06T15:00:00Z'),
      fill('flat-buy', 'buy', 1, 100, '2026-05-07T15:00:00Z'),
      fill('flat-sell', 'sell', 1, 100, '2026-05-08T15:00:00Z'),
    ]);
    const { days, months } = aggregateTradeHistory(history, 'UTC');
    expect(days).toEqual([
      { date: '2026-05-04', realizedPl: 20, exits: 2 },
      { date: '2026-05-06', realizedPl: -10, exits: 1 },
      { date: '2026-05-08', realizedPl: 0, exits: 1 },
    ]);
    expect(months[0]).toEqual({
      month: '2026-05', realizedPl: 10, closedTrades: 3, wins: 1, losses: 1, breakeven: 1,
      winRate: 100 / 3, profitFactor: 2, averageTrade: 10 / 3, bestDay: 20, worstDay: -10, activeDays: 3,
    });
  });

  it('deduplicates sell fills while counting one exit across multiple matched trades', () => {
    const activities = [
      fill('buy-a', 'buy', 1, 100, '2026-09-17T14:00:00Z'),
      fill('buy-b', 'buy', 1, 110, '2026-09-17T14:01:00Z'),
      fill('sell', 'sell', 2, 120, '2026-09-17T14:02:00Z'),
    ];
    const history = reconstructTrades([...activities].reverse().concat(activities));
    expect(history.realizedExits).toHaveLength(2);
    const { days, months } = aggregateTradeHistory(history, 'UTC');
    expect(days).toEqual([{ date: '2026-09-17', realizedPl: 30, exits: 1 }]);
    expect(months[0]).toMatchObject({ realizedPl: 30, closedTrades: 2, wins: 2, winRate: 100, averageTrade: 15, activeDays: 1 });
  });

  it('uses local date and month boundaries through daylight saving changes', () => {
    const history = reconstructTrades([
      fill('buy', 'buy', 4, 100, '2026-02-27T15:00:00Z'),
      fill('february', 'sell', 1, 101, '2026-03-01T00:30:00Z'),
      fill('before-dst', 'sell', 1, 102, '2026-03-08T04:30:00Z'),
      fill('after-dst', 'sell', 1, 103, '2026-03-09T04:30:00Z'),
      fill('march', 'sell', 1, 104, '2026-04-01T03:30:00Z'),
    ]);
    const local = aggregateTradeHistory(history, 'America/New_York');
    expect(local.days).toEqual([
      { date: '2026-02-28', realizedPl: 1, exits: 1 },
      { date: '2026-03-07', realizedPl: 2, exits: 1 },
      { date: '2026-03-09', realizedPl: 3, exits: 1 },
      { date: '2026-03-31', realizedPl: 4, exits: 1 },
    ]);
    expect(local.months.map(month => [month.month, month.realizedPl, month.closedTrades])).toEqual([
      ['2026-03', 9, 1], ['2026-02', 1, 0],
    ]);
    expect(aggregateTradeHistory(history, 'UTC').months.map(month => [month.month, month.realizedPl, month.closedTrades])).toEqual([
      ['2026-04', 4, 1], ['2026-03', 6, 0],
    ]);
    expect(aggregateTradeHistory(history)).toEqual(aggregateTradeHistory(history, Intl.DateTimeFormat().resolvedOptions().timeZone));
  });

  it('excludes unmatched sells, subsequent short covers, option fills, and open-only months', () => {
    const history = reconstructTrades([
      fill('short', 'sell', 2, 100, '2026-01-02T15:00:00Z'),
      fill('cover', 'buy', 2, 90, '2026-01-03T15:00:00Z'),
      fill('option-buy', 'buy', 1, 1, '2026-02-01T15:00:00Z', 'option-buy', 'SPY260918C00600000'),
      fill('option-sell', 'sell', 1, 2, '2026-02-02T15:00:00Z', 'option-sell', 'SPY260918C00600000'),
      fill('open', 'buy', 1, 100, '2026-03-01T15:00:00Z'),
    ]);
    expect(history.realizedExits).toEqual([]);
    expect(aggregateTradeHistory(history, 'UTC')).toEqual({ days: [], months: [] });
    expect(aggregateTradeHistory(reconstructTrades([]), 'UTC')).toEqual({ days: [], months: [] });
  });

  it('includes only the matched portion of an oversell', () => {
    const history = reconstructTrades([
      fill('buy', 'buy', 1, 100, '2026-09-17T14:00:00Z'),
      fill('sell', 'sell', 3, 110, '2026-09-17T14:01:00Z'),
    ]);
    expect(history.realizedExits[0]).toMatchObject({ qty: 1, costBasis: 100, realizedPl: 10 });
    expect(aggregateTradeHistory(history, 'UTC').days).toEqual([{ date: '2026-09-17', realizedPl: 10, exits: 1 }]);
  });

  it('retains fractional profits while classifying floating-point noise as breakeven', () => {
    const history = reconstructTrades([
      fill('tiny-buy', 'buy', 0.000000003, 100, '2026-09-16T14:00:00Z'),
      fill('tiny-sell', 'sell', 0.000000003, 110, '2026-09-16T14:01:00Z'),
      fill('flat-buy', 'buy', 1, 0.1 + 0.2, '2026-09-17T14:00:00Z'),
      fill('flat-sell', 'sell', 1, 0.3, '2026-09-17T14:01:00Z'),
    ]);
    const { days, months } = aggregateTradeHistory(history, 'UTC');
    expect(days[0].realizedPl).toBeCloseTo(0.00000003, 14);
    expect(days[1].realizedPl).toBe(0);
    expect(months[0]).toMatchObject({ closedTrades: 2, wins: 1, losses: 0, breakeven: 1, winRate: 50, profitFactor: null, activeDays: 2 });
    expect(months[0].realizedPl).toBeCloseTo(0.00000003, 14);
    expect(months[0].averageTrade).toBeCloseTo(0.000000015, 14);
  });

  it('returns zero profit factor for all-losing trades and no ratio for flat trades', () => {
    const history = reconstructTrades([
      fill('buy', 'buy', 1, 100, '2026-08-01T14:00:00Z'),
      fill('sell', 'sell', 1, 90, '2026-08-02T14:00:00Z'),
      fill('flat-buy', 'buy', 1, 100, '2026-09-01T14:00:00Z'),
      fill('flat-sell', 'sell', 1, 100, '2026-09-02T14:00:00Z'),
    ]);
    expect(aggregateTradeHistory(history, 'UTC').months).toMatchObject([
      { month: '2026-09', winRate: 0, profitFactor: null, averageTrade: 0 },
      { month: '2026-08', winRate: 0, profitFactor: 0, averageTrade: -10 },
    ]);
  });

  it('shows offsetting fractional profits as a flat day without rounding monetary precision', () => {
    const history = reconstructTrades([
      fill('buy-a', 'buy', 0.1, 0.1, '2026-09-17T14:00:00Z'),
      fill('sell-a', 'sell', 0.1, 0.2, '2026-09-17T14:01:00Z'),
      fill('buy-b', 'buy', 0.1, 0.1, '2026-09-17T14:02:00Z'),
      fill('sell-b', 'sell', 0.1, 0.3, '2026-09-17T14:03:00Z'),
      fill('buy-c', 'buy', 0.1, 0.4, '2026-09-17T14:04:00Z'),
      fill('sell-c', 'sell', 0.1, 0.1, '2026-09-17T14:05:00Z'),
    ]);
    const { days, months } = aggregateTradeHistory(history, 'UTC');
    expect(days).toEqual([{ date: '2026-09-17', realizedPl: 0, exits: 3 }]);
    expect(months[0]).toMatchObject({ realizedPl: 0, averageTrade: 0, bestDay: 0, worstDay: 0, wins: 2, losses: 1 });
  });

  it('skips invalid execution dates without inventing a calendar date', () => {
    const history = reconstructTrades([
      fill('buy', 'buy', 1, 100, '2026-09-17T14:00:00Z'),
      fill('sell', 'sell', 1, 110, '2026-09-17T14:01:00Z'),
    ]);
    history.realizedExits[0].soldAt = 'invalid';
    history.trades[0].closedAt = 'invalid';
    expect(aggregateTradeHistory(history, 'UTC')).toEqual({ days: [], months: [] });
  });
});
