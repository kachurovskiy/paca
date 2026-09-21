import { describe, expect, it, vi } from 'vitest';
import { isOvernightTime, isTradingSessionOpen, tradingSession } from './trading-session';
import type { MarketClock } from './types';

const closed: MarketClock = {
  isOpen: false,
  timestamp: '2026-09-17T20:00:00Z',
  nextOpen: '2026-09-18T13:30:00Z',
  nextClose: '2026-09-18T20:00:00Z',
};

describe('24/5 trading sessions', () => {
  it.each([
    ['2026-09-18T19:59:59.999-04:00', 'extended'],
    ['2026-09-18T20:00:00-04:00', 'weekend'],
    ['2026-09-19T12:00:00-04:00', 'weekend'],
    ['2026-09-20T19:59:59.999-04:00', 'weekend'],
    ['2026-09-20T20:00:00-04:00', 'overnight'],
    ['2026-09-21T03:59:59.999-04:00', 'overnight'],
    ['2026-09-21T04:00:00-04:00', 'extended'],
    ['2026-09-21T19:59:59.999-04:00', 'extended'],
    ['2026-09-21T20:00:00-04:00', 'overnight'],
    ['2026-09-25T03:59:59.999-04:00', 'overnight'],
  ])('classifies %s as %s', (time, expected) => {
    const now = Date.parse(time);
    expect(tradingSession(closed, now)).toBe(expected);
    expect(isTradingSessionOpen(closed, now)).toBe(expected !== 'weekend');
    expect(isOvernightTime(now)).toBe(expected === 'overnight');
  });

  it.each([
    ['2026-03-06T19:59:59.999-05:00', 'extended'],
    ['2026-03-06T20:00:00-05:00', 'weekend'],
    ['2026-03-08T19:59:59.999-04:00', 'weekend'],
    ['2026-03-08T20:00:00-04:00', 'overnight'],
    ['2026-10-30T19:59:59.999-04:00', 'extended'],
    ['2026-10-30T20:00:00-04:00', 'weekend'],
    ['2026-11-01T19:59:59.999-05:00', 'weekend'],
    ['2026-11-01T20:00:00-05:00', 'overnight'],
    ['2026-11-02T03:59:59.999-05:00', 'overnight'],
    ['2026-11-02T04:00:00-05:00', 'extended'],
  ])('keeps New York boundaries through daylight-saving transitions at %s', (time, expected) => {
    expect(tradingSession(closed, Date.parse(time))).toBe(expected);
  });

  it('uses the broker early close for the switch from regular to extended hours', () => {
    const clock: MarketClock = {
      isOpen: true, timestamp: '2026-11-27T12:59:00-05:00',
      nextClose: '2026-11-27T13:00:00-05:00', nextOpen: '2026-11-30T09:30:00-05:00',
    };
    expect(tradingSession(clock, Date.parse('2026-11-27T12:59:59.999-05:00'))).toBe('regular');
    expect(tradingSession(clock, Date.parse(clock.nextClose))).toBe('extended');
    expect(isTradingSessionOpen(clock, Date.parse(clock.nextClose))).toBe(true);
  });

  it('requires broker confirmation before classifying regular hours', () => {
    const now = Date.parse('2026-09-18T12:00:00-04:00');
    expect(tradingSession(closed, now)).toBe('extended');
    expect(tradingSession({ ...closed, isOpen: true }, now)).toBe('regular');
    for (const nextClose of ['', 'invalid', new Date(now).toISOString()]) {
      expect(tradingSession({ ...closed, isOpen: true, nextClose }, now)).toBe('extended');
    }
  });

  it('does not let an old open clock override overnight or weekend boundaries', () => {
    const clock = { ...closed, isOpen: true, nextClose: '2026-09-25T20:00:00-04:00' };
    expect(tradingSession(clock, Date.parse('2026-09-17T20:00:00-04:00'))).toBe('overnight');
    expect(tradingSession(clock, Date.parse('2026-09-18T20:00:00-04:00'))).toBe('weekend');
  });

  it('requires a valid clock timestamp and current time', () => {
    const now = Date.parse(closed.timestamp);
    for (const clock of [null, { ...closed, timestamp: '' }, { ...closed, timestamp: 'invalid' }]) {
      expect(tradingSession(clock, now)).toBe('unavailable');
      expect(isTradingSessionOpen(clock, now)).toBe(false);
    }
    for (const currentTime of [NaN, Infinity, -Infinity, Number.MAX_VALUE]) {
      expect(tradingSession(closed, currentTime)).toBe('unavailable');
      expect(isTradingSessionOpen(closed, currentTime)).toBe(false);
      expect(isOvernightTime(currentTime)).toBe(false);
    }
  });

  it('uses the system time by default, including for independent overnight feed routing', () => {
    const now = Date.parse('2026-09-20T20:00:00-04:00');
    const spy = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      expect(tradingSession(closed)).toBe('overnight');
      expect(isTradingSessionOpen(closed)).toBe(true);
      expect(isOvernightTime()).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});
