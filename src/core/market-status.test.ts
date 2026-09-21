import { describe, expect, it, vi } from 'vitest';
import { marketStatus } from './market-status';
import type { MarketClock } from './types';

const now = Date.parse('2026-09-17T19:00:00Z');
const open: MarketClock = {
  isOpen: true,
  timestamp: new Date(now).toISOString(),
  nextClose: '2026-09-17T20:00:00Z',
  nextOpen: '2026-09-18T13:30:00Z',
};

describe('market status countdown', () => {
  it('shows the authoritative next close while the market is open', () => {
    expect(marketStatus(open, now)).toEqual({
      status: 'US market open', isOpen: true, countdown: 'Closes in 1h 00m', eventTime: open.nextClose,
    });
  });

  it('uses the authoritative next open across weekends or exchange holidays', () => {
    const closed = { ...open, isOpen: false, nextOpen: '2026-09-19T22:05:00Z' };
    expect(marketStatus(closed, now)).toEqual({
      status: 'US market closed', isOpen: false, countdown: 'Opens in 2d 3h 05m', eventTime: closed.nextOpen,
    });
  });

  it('respects broker-provided early closes without assuming regular session hours', () => {
    const clock = { ...open, timestamp: '2026-11-27T16:30:00Z', nextClose: '2026-11-27T13:00:00-05:00' };
    expect(marketStatus(clock, Date.parse(clock.timestamp)).countdown).toBe('Closes in 1h 30m');
  });

  it('uses elapsed time across UTC offsets and daylight-saving changes', () => {
    const clock = { ...open, isOpen: false, timestamp: '2026-10-30T16:00:00-04:00', nextOpen: '2026-11-02T09:30:00-05:00' };
    expect(marketStatus(clock, Date.parse(clock.timestamp)).countdown).toBe('Opens in 2d 18h 30m');
  });

  it.each([
    [1, '<1m'],
    [59_999, '<1m'],
    [60_000, '1m'],
    [60_001, '2m'],
    [59 * 60_000 + 1, '1h 00m'],
    [60 * 60_000 + 1, '1h 01m'],
    [24 * 60 * 60_000 - 1, '1d 0h 00m'],
  ])('rounds %s remaining milliseconds into %s', (remaining, expected) => {
    const clock = { ...open, nextClose: new Date(now + remaining).toISOString() };
    expect(marketStatus(clock, now).countdown).toBe(`Closes in ${expected}`);
  });

  it.each([true, false])('waits for refreshed clock data when the %s boundary has elapsed', isOpen => {
    const clock = { ...open, isOpen, nextOpen: new Date(now).toISOString(), nextClose: new Date(now).toISOString() };
    for (const currentTime of [now, now + 10_000]) {
      expect(marketStatus(clock, currentTime)).toEqual({
        status: 'Updating market status', isOpen: false, countdown: '', eventTime: null,
      });
    }
    expect(clock.isOpen).toBe(isOpen);
  });

  it('keeps known market state if the relevant schedule is missing or malformed', () => {
    for (const nextClose of ['', 'invalid']) {
      expect(marketStatus({ ...open, nextClose }, now)).toEqual({
        status: 'US market open', isOpen: true, countdown: 'Schedule unavailable', eventTime: null,
      });
    }
    expect(marketStatus({ ...open, isOpen: false, nextOpen: '' }, now)).toEqual({
      status: 'US market closed', isOpen: false, countdown: 'Schedule unavailable', eventTime: null,
    });
  });

  it('does not require the inactive boundary to calculate a countdown', () => {
    expect(marketStatus({ ...open, nextOpen: '' }, now).countdown).toBe('Closes in 1h 00m');
    expect(marketStatus({ ...open, isOpen: false, nextClose: '' }, now).countdown).toBe('Opens in 18h 30m');
  });

  it('reports unavailable status when the clock is absent or its timestamp is malformed', () => {
    for (const clock of [null, { ...open, timestamp: '' }, { ...open, timestamp: 'invalid' }]) {
      expect(marketStatus(clock, now)).toEqual({
        status: 'Market status unavailable', isOpen: false, countdown: 'Schedule unavailable', eventTime: null,
      });
    }
  });

  it('avoids an invalid countdown if the current time is invalid', () => {
    for (const currentTime of [NaN, Infinity, -Infinity]) {
      expect(marketStatus(open, currentTime).status).toBe('Market status unavailable');
      expect(marketStatus(open, currentTime).countdown).toBe('Schedule unavailable');
    }
  });

  it('uses the current system time by default', () => {
    const spy = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      expect(marketStatus(open).countdown).toBe('Closes in 1h 00m');
    } finally {
      spy.mockRestore();
    }
  });
});
