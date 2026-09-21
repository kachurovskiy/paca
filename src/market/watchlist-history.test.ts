import { describe, expect, it } from 'vitest';
import type { Bar } from '../core/types';
import { WATCHLIST_BAR_MS, WATCHLIST_WINDOW_MS, watchlistTrend } from './watchlist-history';

const now = Date.parse('2026-09-17T14:30:00Z');
const bar = (closeAt: number, price: number): Bar => ({ t: new Date(closeAt - WATCHLIST_BAR_MS).toISOString(), o: price, h: price, l: price, c: price, v: 100 });

describe('last available 24-hour watchlist prices', () => {
  it('includes overnight observations, removes old and unfinished bars, and uses the newest trade', () => {
    const start = now - WATCHLIST_WINDOW_MS;
    const result = watchlistTrend([
      bar(start - 1, 50), bar(start, 100), bar(Date.parse('2026-09-17T02:00:00Z'), 103),
      bar(now - WATCHLIST_BAR_MS, 105), bar(now + 1, 200),
    ], { price: 110, timestamp: new Date(now).toISOString() }, now);
    expect(result.points.map(point => point.price)).toEqual([100, 103, 105, 110]);
    expect(result.changePercent).toBeCloseTo(10);
  });

  it('sorts observations, applies bar revisions, and rejects invalid prices and stale or future trades', () => {
    const bars = [bar(now - 60_000, 100), bar(now - 600_000, 110), bar(now - 60_000, 99),
      bar(now - 120_000, NaN), bar(now - 180_000, 0), { ...bar(now, 100), t: 'invalid' }];
    for (const timestamp of [now - 120_000, now + 1]) {
      const result = watchlistTrend(bars, { price: 500, timestamp: new Date(timestamp).toISOString() }, now);
      expect(result.points.map(point => point.price)).toEqual([110, 99]);
      expect(result.changePercent).toBeCloseTo(-10);
    }
  });

  it('does not invent a change from a single observation', () => {
    expect(watchlistTrend([], undefined, now)).toEqual({ points: [], changePercent: null, end: now });
    expect(watchlistTrend([], { price: 100, timestamp: new Date(now).toISOString() }, now).changePercent).toBeNull();
  });

  it.each(['2026-09-20T14:30:00Z', '2026-09-21T12:00:00Z', '2026-09-22T12:00:00Z'])(
    'retains the last available day through weekends, premarket and holidays (%s)', timestamp => {
      const end = Date.parse('2026-09-18T20:00:00Z');
      const bars = [bar(end - WATCHLIST_WINDOW_MS - 1, 50), bar(end - WATCHLIST_WINDOW_MS, 100),
        bar(end - 6 * 60 * 60_000, 102), bar(end, 105)];
      const result = watchlistTrend(bars, { price: 105, timestamp: new Date(end).toISOString() }, Date.parse(timestamp));
      expect(result.end).toBe(end);
      expect(result.points.map(point => point.price)).toEqual([100, 102, 105]);
      expect(result.changePercent).toBeCloseTo(5);
    });

  it('moves the window when new observations become available again', () => {
    const end = Date.parse('2026-09-18T20:00:00Z'), monday = Date.parse('2026-09-21T14:00:00Z');
    const result = watchlistTrend([bar(end - 60_000, 100), bar(end, 105), bar(monday - 60_000, 106)],
      { price: 107, timestamp: new Date(monday).toISOString() }, monday);
    expect(result.end).toBe(monday);
    expect(result.points.map(point => point.price)).toEqual([106, 107]);
  });

  it('keeps unchanged prices flat and replaces a close with a trade at the same timestamp', () => {
    const bars = [bar(now - 60_000, 100), bar(now, 105)];
    const result = watchlistTrend(bars, { price: 100, timestamp: new Date(now).toISOString() }, now);
    expect(result.points.map(point => point.price)).toEqual([100, 100]);
    expect(result.changePercent).toBe(0);
  });
});
