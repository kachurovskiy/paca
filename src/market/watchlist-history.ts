import type { Bar, Quote } from '../core/types';

export const WATCHLIST_WINDOW_MS = 24 * 60 * 60_000;
export const WATCHLIST_LOOKBACK_MS = 14 * WATCHLIST_WINDOW_MS;
export const WATCHLIST_BAR_MS = 5 * 60_000;
export interface WatchlistPoint { at: number; price: number }

/** The 24 hours ending at the latest available observation, including during market closures. */
export function watchlistTrend(bars: readonly Bar[], quote: Pick<Quote, 'price' | 'timestamp'> | undefined, now: number) {
  const values = new Map<number, WatchlistPoint>();
  for (const bar of bars) {
    const at = Date.parse(bar.t) + WATCHLIST_BAR_MS;
    if (at > now || !Number.isFinite(at) || !Number.isFinite(bar.c) || bar.c <= 0) continue;
    values.set(at, { at, price: bar.c });
  }
  const points = [...values.values()].sort((a, b) => a.at - b.at);
  const last = points.at(-1), tradeAt = Date.parse(quote?.timestamp ?? '');
  if (quote && Number.isFinite(quote.price) && quote.price > 0 && Number.isFinite(tradeAt) && tradeAt <= now && (!last || tradeAt >= last.at)) {
    if (last?.at === tradeAt) points.pop();
    points.push({ at: tradeAt, price: quote.price });
  }
  const end = points.at(-1)?.at ?? now;
  const available = points.filter(point => point.at >= end - WATCHLIST_WINDOW_MS);
  const changePercent = available.length < 2 ? null : (available.at(-1)!.price / available[0].price - 1) * 100;
  return { points: available, changePercent, end };
}
