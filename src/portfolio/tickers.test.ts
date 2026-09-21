import { describe, expect, it } from 'vitest';
import { aggregateTickerHistory } from './tickers';
import { reconstructTrades } from './trades';
import type { TradeActivity } from '../core/types';

function fill(id: string, side: 'buy' | 'sell', qty: number, price: number, transactionTime: string, symbol = 'AAPL', orderId = id): TradeActivity {
  return { id, orderId, symbol, side, qty, price, transactionTime, type: 'fill' };
}

describe('ticker history analytics', () => {
  it('combines trades per ticker, retaining partial exits and marking only remaining shares', () => {
    const history = reconstructTrades([
      fill('winner-buy', 'buy', 2, 100, '2026-09-01T14:00:00Z'),
      fill('winner-sell', 'sell', 2, 110, '2026-09-02T14:00:00Z'),
      fill('loser-buy', 'buy', 1, 100, '2026-09-03T14:00:00Z'),
      fill('loser-sell', 'sell', 1, 90, '2026-09-04T14:00:00Z'),
      fill('partial-buy', 'buy', 2, 50, '2026-09-05T14:00:00Z'),
      fill('partial-sell', 'sell', 1, 80, '2026-09-06T14:00:00Z'),
      fill('msft-buy', 'buy', 2, 200, '2026-09-07T14:00:00Z', 'MSFT'),
      fill('tsla-buy', 'buy', 1, 100, '2026-09-08T14:00:00Z', 'TSLA'),
      fill('tsla-sell', 'sell', 1, 85, '2026-09-09T14:00:00Z', 'TSLA'),
    ]);
    const marks: Record<string, number> = { AAPL: 75, MSFT: 210 };
    expect(aggregateTickerHistory(history.trades, symbol => marks[symbol])).toEqual([
      {
        symbol: 'AAPL', trades: 3, openTrades: 1, closedTrades: 2,
        wins: 1, losses: 1, breakeven: 0, winRate: 50,
        realizedPl: 40, realizedCostBasis: 350, openCostBasis: 50,
        unrealizedPl: 25, totalPl: 65,
      },
      {
        symbol: 'MSFT', trades: 1, openTrades: 1, closedTrades: 0,
        wins: 0, losses: 0, breakeven: 0, winRate: null,
        realizedPl: 0, realizedCostBasis: 0, openCostBasis: 400,
        unrealizedPl: 20, totalPl: 20,
      },
      {
        symbol: 'TSLA', trades: 1, openTrades: 0, closedTrades: 1,
        wins: 0, losses: 1, breakeven: 0, winRate: 0,
        realizedPl: -15, realizedCostBasis: 100, openCostBasis: 0,
        unrealizedPl: 0, totalPl: -15,
      },
    ]);
  });

  it('counts simultaneous buys as one closed trade and includes breakeven trades in win rate', () => {
    const history = reconstructTrades([
      fill('group-buy-a', 'buy', 1, 100, '2026-09-01T14:00:00Z'),
      fill('group-buy-b', 'buy', 1, 110, '2026-09-01T14:00:00Z'),
      fill('group-sell', 'sell', 2, 115, '2026-09-02T14:00:00Z'),
      fill('flat-buy', 'buy', 1, 100, '2026-09-03T14:00:00Z'),
      fill('flat-sell', 'sell', 1, 100, '2026-09-04T14:00:00Z'),
    ]);
    expect(aggregateTickerHistory(history.trades, () => undefined)).toEqual([{
      symbol: 'AAPL', trades: 2, openTrades: 0, closedTrades: 2,
      wins: 1, losses: 0, breakeven: 1, winRate: 50,
      realizedPl: 20, realizedCostBasis: 310, openCostBasis: 0,
      unrealizedPl: 0, totalPl: 20,
    }]);
  });

  it.each([null, undefined, NaN, Infinity, -Infinity, 0, -1])('keeps unknown open P/L unknown for mark %s while retaining realized results', price => {
    const history = reconstructTrades([
      fill('buy', 'buy', 2, 100, '2026-09-01T14:00:00Z'),
      fill('partial-sell', 'sell', 1, 110, '2026-09-02T14:00:00Z'),
    ]);
    expect(aggregateTickerHistory(history.trades, () => price)).toEqual([{
      symbol: 'AAPL', trades: 1, openTrades: 1, closedTrades: 0,
      wins: 0, losses: 0, breakeven: 0, winRate: null,
      realizedPl: 10, realizedCostBasis: 100, openCostBasis: 100,
      unrealizedPl: null, totalPl: null,
    }]);
  });

  it('does not request marks for closed tickers and sorts equal realized results by ticker', () => {
    const history = reconstructTrades([
      fill('msft-buy', 'buy', 1, 100, '2026-09-01T14:00:00Z', 'MSFT'),
      fill('msft-sell', 'sell', 1, 110, '2026-09-02T14:00:00Z', 'MSFT'),
      fill('aapl-buy', 'buy', 1, 100, '2026-09-03T14:00:00Z'),
      fill('aapl-sell', 'sell', 1, 110, '2026-09-04T14:00:00Z'),
    ]);
    const summary = aggregateTickerHistory(history.trades, () => { throw new Error('Closed tickers need no mark'); });
    expect(summary.map(ticker => [ticker.symbol, ticker.unrealizedPl, ticker.totalPl])).toEqual([
      ['AAPL', 0, 10], ['MSFT', 0, 10],
    ]);
  });

  it('retains fractional profits and cost bases while classifying floating-point noise as flat', () => {
    const history = reconstructTrades([
      fill('tiny-buy', 'buy', 0.000000003, 100, '2026-09-01T14:00:00Z'),
      fill('tiny-sell', 'sell', 0.000000003, 110, '2026-09-02T14:00:00Z'),
      fill('flat-buy', 'buy', 1, 0.1 + 0.2, '2026-09-03T14:00:00Z'),
      fill('flat-sell', 'sell', 1, 0.3, '2026-09-04T14:00:00Z'),
      fill('tiny-open', 'buy', 0.000000003, 100, '2026-09-05T14:00:00Z'),
      fill('flat-open', 'buy', 1, 0.1 + 0.2, '2026-09-06T14:00:00Z', 'MSFT'),
    ]);
    const [aapl, msft] = aggregateTickerHistory(history.trades, symbol => symbol === 'AAPL' ? 110 : 0.3);
    expect(aapl).toMatchObject({ trades: 3, openTrades: 1, closedTrades: 2, wins: 1, losses: 0, breakeven: 1, winRate: 50 });
    expect(aapl.realizedPl).toBeCloseTo(0.00000003, 14);
    expect(aapl.unrealizedPl).toBeCloseTo(0.00000003, 14);
    expect(aapl.totalPl).toBeCloseTo(0.00000006, 14);
    expect(aapl.openCostBasis).toBeCloseTo(0.0000003, 14);
    expect(msft).toMatchObject({ realizedPl: 0, unrealizedPl: 0, totalPl: 0 });
  });

  it('returns no rows when no supported long trades exist', () => {
    const history = reconstructTrades([
      fill('short', 'sell', 1, 100, '2026-09-01T14:00:00Z'),
      fill('cover', 'buy', 1, 90, '2026-09-02T14:00:00Z'),
      fill('option-buy', 'buy', 1, 1, '2026-09-03T14:00:00Z', 'SPY260918C00600000'),
    ]);
    expect(aggregateTickerHistory(history.trades, () => 100)).toEqual([]);
    expect(aggregateTickerHistory([], () => undefined)).toEqual([]);
  });
});
