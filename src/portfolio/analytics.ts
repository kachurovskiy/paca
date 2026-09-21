import type { ReconstructedTradeHistory } from './trades';

export interface DailySummary {
  date: string;
  realizedPl: number;
  /** Unique sell fills with matched long shares on this date. */
  exits: number;
}

export interface MonthlySummary {
  month: string;
  realizedPl: number;
  closedTrades: number;
  wins: number;
  losses: number;
  breakeven: number;
  /** Percentage of all fully closed trades, including breakeven trades. */
  winRate: number | null;
  /** Gross winning / losing P/L of closed trades; null when there are no losses. */
  profitFactor: number | null;
  averageTrade: number | null;
  bestDay: number | null;
  worstDay: number | null;
  activeDays: number;
}

export interface TradeHistorySummary {
  days: DailySummary[];
  months: MonthlySummary[];
}

interface MonthTotals {
  summary: MonthlySummary;
  closedPl: number;
  grossProfit: number;
  grossLoss: number;
}

// Keep fractional-share precision while treating floating-point noise as flat.
const profitEpsilon = 1e-8;
const cleanProfit = (value: number): number => Math.abs(value) <= profitEpsilon ? 0 : value;

/**
 * Attribute realized P/L to each sell's local date, including partial exits.
 * Trade outcome statistics count grouped trades only once they fully close.
 * Buy-only dates are omitted because they have no realized result.
 */
export function aggregateTradeHistory(
  history: ReconstructedTradeHistory,
  timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone,
): TradeHistorySummary {
  const dateFormatter = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const dateKey = (timestamp: string): string | null => {
    const milliseconds = Date.parse(timestamp);
    if (!Number.isFinite(milliseconds)) return null;
    const parts = dateFormatter.formatToParts(milliseconds);
    const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(value => value.type === type)!.value;
    return `${part('year')}-${part('month')}-${part('day')}`;
  };
  const days = new Map<string, { realizedPl: number; fillIds: Set<string> }>();
  const months = new Map<string, MonthTotals>();
  const monthTotals = (month: string): MonthTotals => {
    let totals = months.get(month);
    if (!totals) {
      totals = {
        summary: {
          month, realizedPl: 0, closedTrades: 0, wins: 0, losses: 0, breakeven: 0,
          winRate: null, profitFactor: null, averageTrade: null, bestDay: null, worstDay: null, activeDays: 0,
        },
        closedPl: 0, grossProfit: 0, grossLoss: 0,
      };
      months.set(month, totals);
    }
    return totals;
  };

  for (const exit of history.realizedExits) {
    const date = dateKey(exit.soldAt);
    if (!date || !Number.isFinite(exit.realizedPl)) continue;
    let day = days.get(date);
    if (!day) {
      day = { realizedPl: 0, fillIds: new Set() };
      days.set(date, day);
    }
    // One sell can consume multiple buy orders. Sum each matched portion but
    // count the broker fill only once in the calendar.
    day.realizedPl += exit.realizedPl;
    day.fillIds.add(exit.id);
  }
  for (const [date, day] of days) {
    day.realizedPl = cleanProfit(day.realizedPl);
    const { summary } = monthTotals(date.slice(0, 7));
    summary.realizedPl += day.realizedPl;
    summary.bestDay = summary.bestDay === null ? day.realizedPl : Math.max(summary.bestDay, day.realizedPl);
    summary.worstDay = summary.worstDay === null ? day.realizedPl : Math.min(summary.worstDay, day.realizedPl);
    summary.activeDays++;
  }

  for (const trade of history.trades) {
    if (trade.openQty !== 0 || !trade.closedAt || !Number.isFinite(trade.realizedPl)) continue;
    const date = dateKey(trade.closedAt);
    if (!date) continue;
    const totals = monthTotals(date.slice(0, 7));
    totals.summary.closedTrades++;
    totals.closedPl += trade.realizedPl;
    if (trade.realizedPl > profitEpsilon) {
      totals.summary.wins++;
      totals.grossProfit += trade.realizedPl;
    } else if (trade.realizedPl < -profitEpsilon) {
      totals.summary.losses++;
      totals.grossLoss -= trade.realizedPl;
    } else {
      totals.summary.breakeven++;
    }
  }

  return {
    days: [...days].map(([date, day]) => ({ date, realizedPl: day.realizedPl, exits: day.fillIds.size }))
      .sort((a, b) => a.date.localeCompare(b.date)),
    months: [...months.values()].map(({ summary, closedPl, grossProfit, grossLoss }) => ({
      ...summary,
      realizedPl: cleanProfit(summary.realizedPl),
      winRate: summary.closedTrades ? 100 * summary.wins / summary.closedTrades : null,
      profitFactor: grossLoss ? grossProfit / grossLoss : null,
      averageTrade: summary.closedTrades ? cleanProfit(closedPl / summary.closedTrades) : null,
    })).sort((a, b) => b.month.localeCompare(a.month)),
  };
}
