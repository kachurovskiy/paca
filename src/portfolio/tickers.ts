import type { HistoryTrade } from './trades';

export interface TickerSummary {
  symbol: string;
  trades: number;
  openTrades: number;
  closedTrades: number;
  wins: number;
  losses: number;
  breakeven: number;
  /** Percentage of all fully closed trades, including breakeven trades. */
  winRate: number | null;
  /** Includes realized results from partially closed trades. */
  realizedPl: number;
  realizedCostBasis: number;
  openCostBasis: number;
  /** Null when open shares cannot be valued with a valid current mark. */
  unrealizedPl: number | null;
  totalPl: number | null;
}

const profitEpsilon = 1e-8;
const cleanProfit = (value: number): number => Math.abs(value) <= profitEpsilon ? 0 : value;

/** Summarize reconstructed long trades by ticker, retaining partial exits. */
export function aggregateTickerHistory(
  trades: readonly HistoryTrade[],
  priceForSymbol: (symbol: string) => number | null | undefined,
): TickerSummary[] {
  const tickers = new Map<string, { summary: TickerSummary; openQty: number }>();

  for (const trade of trades) {
    let totals = tickers.get(trade.symbol);
    if (!totals) {
      totals = {
        summary: {
          symbol: trade.symbol, trades: 0, openTrades: 0, closedTrades: 0,
          wins: 0, losses: 0, breakeven: 0, winRate: null,
          realizedPl: 0, realizedCostBasis: 0, openCostBasis: 0,
          unrealizedPl: 0, totalPl: 0,
        },
        openQty: 0,
      };
      tickers.set(trade.symbol, totals);
    }
    const { summary } = totals;
    summary.trades++;
    summary.realizedPl += trade.realizedPl;
    summary.realizedCostBasis += trade.realizedCostBasis;
    summary.openCostBasis += trade.openCostBasis;
    totals.openQty += trade.openQty;

    if (trade.openQty > 0) {
      summary.openTrades++;
    } else {
      summary.closedTrades++;
      if (trade.realizedPl > profitEpsilon) summary.wins++;
      else if (trade.realizedPl < -profitEpsilon) summary.losses++;
      else summary.breakeven++;
    }
  }

  return [...tickers.values()].map(({ summary, openQty }) => {
    const price = openQty > 0 ? priceForSymbol(summary.symbol) : null;
    const unrealizedPl = openQty === 0 ? 0
      : typeof price === 'number' && Number.isFinite(price) && price > 0
        ? openQty * price - summary.openCostBasis
        : null;
    return {
      ...summary,
      winRate: summary.closedTrades ? 100 * summary.wins / summary.closedTrades : null,
      realizedPl: cleanProfit(summary.realizedPl),
      unrealizedPl: unrealizedPl === null ? null : cleanProfit(unrealizedPl),
      totalPl: unrealizedPl === null ? null : cleanProfit(summary.realizedPl + unrealizedPl),
    };
  }).sort((a, b) => b.realizedPl - a.realizedPl || a.symbol.localeCompare(b.symbol));
}
