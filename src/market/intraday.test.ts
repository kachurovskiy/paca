import { describe, expect, it } from 'vitest';
import { intradaySessionDate, latestIntradaySession, regularSessionMinute } from './intraday';
import type { Bar } from '../core/types';

const bar = (t: string, c = 100): Bar => ({ t, o: c, h: c + 1, l: c - 1, c, v: 100 });

describe('watchlist intraday sessions', () => {
  it('keeps the whole latest regular session, ordered and deduplicated, without pre/post-market or previous-day tails', () => {
    const bars = [
      bar('2026-09-17T19:55:00Z', 102), bar('2026-09-16T19:55:00Z', 99),
      bar('2026-09-17T13:25:00Z', 97), bar('2026-09-17T13:30:00Z', 100),
      bar('2026-09-17T20:00:00Z', 105), bar('2026-09-17T16:00:00Z', 101),
      bar('2026-09-17T16:00:00+00:00', 101.5), bar('invalid', 1000),
    ];
    expect(latestIntradaySession(bars).map(point => point.c)).toEqual([100, 101.5, 102]);
    expect(intradaySessionDate(bars)).toBe('2026-09-17');
  });

  it('retains Friday for weekend and Monday premarket data rather than joining different sessions', () => {
    const bars = [
      bar('2026-09-18T13:30:00Z', 100), bar('2026-09-18T19:55:00Z', 102),
      bar('2026-09-19T15:00:00Z', 110), bar('2026-09-20T15:00:00Z', 120),
      bar('2026-09-21T13:25:00Z', 130),
    ];
    expect(latestIntradaySession(bars).map(point => point.c)).toEqual([100, 102]);
    expect(intradaySessionDate(bars)).toBe('2026-09-18');
    const monday = [...bars, bar('2026-09-21T13:30:00Z', 131)];
    expect(latestIntradaySession(monday).map(point => point.c)).toEqual([131]);
    expect(intradaySessionDate(monday)).toBe('2026-09-21');
  });

  it('uses New York daylight saving boundaries for a fixed intraday horizontal scale', () => {
    expect(regularSessionMinute('2026-03-06T14:30:00Z')).toBe(0);
    expect(regularSessionMinute('2026-03-06T20:55:00Z')).toBe(385);
    expect(regularSessionMinute('2026-03-06T14:25:00Z')).toBeNull();
    expect(regularSessionMinute('2026-03-09T13:30:00Z')).toBe(0);
    expect(regularSessionMinute('2026-03-09T19:55:00Z')).toBe(385);
    expect(regularSessionMinute('2026-03-09T20:00:00Z')).toBeNull();
    expect(regularSessionMinute('2026-11-02T14:30:00Z')).toBe(0);
    expect(regularSessionMinute('2026-11-02T21:00:00Z')).toBeNull();
  });

  it('does not fabricate a line when no regular-session bars exist', () => {
    const bars = [bar('2026-09-17T12:00:00Z'), bar('2026-09-17T21:00:00Z')];
    expect(latestIntradaySession(bars)).toEqual([]);
    expect(intradaySessionDate(bars)).toBeNull();
    expect(latestIntradaySession([])).toEqual([]);
    expect(intradaySessionDate([])).toBeNull();
  });
});
