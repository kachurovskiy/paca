import { describe, expect, it } from 'vitest';
import { calendarTimeToUtc, currentSessionSegment, fullTradingSession, tradingDate, validFullSession } from './exchange-session';

describe('calendar-backed 24/5 horizons', () => {
  it.each([
    ['2026-09-20T19:59:59-04:00', '2026-09-20'], ['2026-09-20T20:00:00-04:00', '2026-09-21'],
    ['2026-09-21T00:00:00-04:00', '2026-09-21'], ['2026-09-21T19:59:59-04:00', '2026-09-21'],
    ['2026-09-21T20:00:00-04:00', '2026-09-22'],
  ])('assigns %s to trade date %s', (at, date) => expect(tradingDate(Date.parse(at))).toBe(date));

  it.each([['2026-03-09', '00'], ['2026-11-02', '01']])('uses New York DST for %s', (date, hour) => {
    const session = fullTradingSession({ date, open: calendarTimeToUtc(date, '09:30'), close: calendarTimeToUtc(date, '16:00') });
    expect(new Date(session.open).toISOString()).toBe(`${date}T${hour}:00:00.000Z`);
    expect(session.close - session.open).toBe(24 * 3_600_000);
    expect(validFullSession(date, new Date(session.open).toISOString(), new Date(session.close).toISOString())).toBe(true);
    expect(validFullSession(date, new Date(session.open + 1).toISOString(), new Date(session.close).toISOString())).toBe(false);
  });

  it.each([['01:00', 'overnight'], ['04:00', 'premarket'], ['09:30', undefined], ['16:00', 'afterhours']])('selects the matching volume segment at %s', (time, mode) => {
    const session = { date: '2026-09-21', open: calendarTimeToUtc('2026-09-21', '09:30'), close: calendarTimeToUtc('2026-09-21', '16:00') };
    const at = calendarTimeToUtc(session.date, time!);
    const segment = currentSessionSegment(session, at);
    expect(segment.mode).toBe(mode); expect(at).toBeGreaterThanOrEqual(segment.open); expect(at).toBeLessThan(segment.close);
  });
});
