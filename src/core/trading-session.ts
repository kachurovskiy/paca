import type { MarketClock } from './types';

export type TradingSession = 'unavailable' | 'weekend' | 'overnight' | 'regular' | 'extended';

const newYorkTime = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', hourCycle: 'h23',
});

function sessionTime(now: number): 'unavailable' | 'weekend' | 'overnight' | 'daytime' {
  if (!Number.isFinite(now) || !Number.isFinite(new Date(now).getTime())) return 'unavailable';
  const parts = newYorkTime.formatToParts(now);
  const day = parts.find(part => part.type === 'weekday')?.value;
  const hour = Number(parts.find(part => part.type === 'hour')?.value);
  if (day === 'Sat' || (day === 'Fri' && hour >= 20) || (day === 'Sun' && hour < 20)) return 'weekend';
  return hour >= 20 || hour < 4 ? 'overnight' : 'daytime';
}

/** The 24/5 session schedule; the broker remains authoritative for holiday restrictions. */
export function tradingSession(clock: MarketClock | null, now = Date.now()): TradingSession {
  if (!clock || !Number.isFinite(Date.parse(clock.timestamp))) return 'unavailable';
  const session = sessionTime(now);
  if (session !== 'daytime') return session;
  const close = Date.parse(clock.nextClose);
  return clock.isOpen && Number.isFinite(close) && now < close ? 'regular' : 'extended';
}

export function isTradingSessionOpen(clock: MarketClock | null, now = Date.now()): boolean {
  const session = tradingSession(clock, now);
  return session === 'overnight' || session === 'regular' || session === 'extended';
}

/** Routes data to the overnight feed without depending on a broker clock response. */
export function isOvernightTime(now = Date.now()): boolean {
  return sessionTime(now) === 'overnight';
}
