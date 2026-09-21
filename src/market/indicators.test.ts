import { describe, expect, it, vi } from 'vitest';
import { computeIndicators, evaluateTrend } from './indicators';
import type { Bar } from '../core/types';

const state = { hasPosition: false, stopLossPct: 1, trailingStopPct: 0.8 };
function candles(closes: number[]): Bar[] {
  // Keep ordinary indicator cases within one known New York session so tests
  // remain independent of the wall clock and midnight VWAP resets.
  const end = Date.UTC(2020, 0, 2, 16, 0);
  return closes.map((close, index) => ({ t: new Date(end - (closes.length - index + 1) * 60000).toISOString(), o: close - 0.1, h: close + 0.2, l: close - 0.2, c: close, v: 1000 }));
}

describe('trend evaluator', () => {
  it('does not trade with insufficient history', () => {
    expect(evaluateTrend(candles([100, 101]), state, Date.now()).action).toBe('hold');
  });
  it('recognizes sustained rising prices and holds an existing position', () => {
    const bars = candles(Array.from({ length: 60 }, (_, index) => 100 + index * 0.2));
    expect(evaluateTrend(bars, state, Date.now())).toMatchObject({ action: 'buy', trend: 'bullish' });
    expect(evaluateTrend(bars, { ...state, hasPosition: true, entryPrice: 100 }, Date.now()).action).toBe('hold');
    expect(computeIndicators(bars).rsi).toBe(100);
  });
  it('exits on trend loss, hard stop, and trailing stop', () => {
    const bars = candles(Array.from({ length: 60 }, (_, index) => 120 - index * 0.2));
    expect(evaluateTrend(bars, { ...state, hasPosition: true }, Date.now()).action).toBe('sell');
    expect(evaluateTrend(bars, { ...state, hasPosition: true, entryPrice: 120 }, Date.now()).reason).toContain('Stop loss');
    expect(evaluateTrend(bars, { ...state, hasPosition: true, peakPrice: 112 }, Date.now()).reason).toContain('Trailing stop');
    expect(computeIndicators(bars).rsi).toBe(0);
  });
  it('never enters on a spike in the unfinished candle', () => {
    const now = Date.now();
    const bars = Array.from({ length: 60 }, (_, index) => ({ t: new Date(now - (59 - index) * 60000).toISOString(), o: 100, h: 100, l: 100, c: index === 59 ? 150 : 100, v: 1000 }));
    vi.spyOn(Date, 'now').mockReturnValue(now);
    expect(evaluateTrend(bars, state, Date.now()).action).toBe('hold');
    vi.restoreAllMocks();
  });
  it('reports unavailable RSI and VWAP when their required inputs are missing', () => {
    expect(computeIndicators([]).rsi).toBeNaN();
    expect(computeIndicators(candles(Array(14).fill(100))).rsi).toBeNaN();
    const bars = candles(Array(30).fill(100)).map(bar => ({ ...bar, v: 0 }));
    expect(computeIndicators(bars).rsi).toBe(50);
    expect(computeIndicators(bars).vwap.every(Number.isNaN)).toBe(true);
    expect(evaluateTrend(bars, state, Date.now()).action).toBe('hold');
  });
  it.each([
    ['summer', '2026-07-01T23:55:00Z', '2026-07-02T00:05:00Z', '2026-07-02T03:55:00Z', '2026-07-02T04:00:00Z', '2026-07-02T04:05:00Z'],
    ['winter', '2026-12-01T23:55:00Z', '2026-12-02T00:05:00Z', '2026-12-02T04:55:00Z', '2026-12-02T05:00:00Z', '2026-12-02T05:05:00Z'],
  ])('resets VWAP at New York midnight in %s, preserving the average across UTC midnight', (_season, ...times) => {
    const prices = [100, 110, 120, 200, 220];
    const volumes = [100, 300, 100, 100, 300];
    const bars = times.map((t, index) => ({ t, o: prices[index], h: prices[index], l: prices[index], c: prices[index], v: volumes[index] }));
    expect(computeIndicators(bars).vwap).toEqual([100, 107.5, 110, 200, 215]);
  });
});

