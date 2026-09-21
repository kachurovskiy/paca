const ny = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
const partsAt = (at: number) => Object.fromEntries(ny.formatToParts(at).map(part => [part.type, part.value]));
export const nextDate = (date: string, days: number) => new Date(Date.parse(`${date}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
export function exchangeDate(at: number): string {
  const p = partsAt(at); return `${p.year}-${p.month}-${p.day}`;
}
/** Trades from 20:00 New York belong to the next exchange date, including Sunday. */
export function tradingDate(at: number): string {
  return nextDate(exchangeDate(at), Number(partsAt(at).hour) >= 20 ? 1 : 0);
}
export function calendarTimeToUtc(date: string, time: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date
    || !/^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(time)) throw new Error('Alpaca returned an invalid exchange calendar time.');
  const [hour, minute, second = 0] = time.split(':').map(Number);
  const target = Date.parse(`${date}T00:00:00Z`) + hour * 3_600_000 + minute * 60_000 + second * 1000;
  let candidate = target;
  for (let attempt = 0; attempt < 3; attempt++) {
    const p = partsAt(candidate), local = Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`);
    if (target === local) return candidate;
    candidate += target - local;
  }
  throw new Error('Ambiguous exchange calendar time.');
}
export const FULL_SESSION_CALENDAR = 'alpaca-us-equity-24x5';
/** Expand only dates returned by the exchange calendar: holidays remain closed. */
export function fullTradingSession<T extends { date: string; open: number; close: number }>(session: T): T {
  return { ...session, open: calendarTimeToUtc(nextDate(session.date, -1), '20:00'), close: calendarTimeToUtc(session.date, '20:00') };
}
export function validFullSession(date: string, open: string, close: string): boolean {
  try {
    const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
    return weekday > 0 && weekday < 6 && Date.parse(open) === calendarTimeToUtc(nextDate(date, -1), '20:00') && Date.parse(close) === calendarTimeToUtc(date, '20:00');
  } catch { return false; }
}
export type SessionSegment = 'overnight' | 'premarket' | 'afterhours';
export function sessionSegment<T extends { date: string; open: number; close: number }>(session: T, mode?: SessionSegment): T & { mode?: SessionSegment } {
  if (!mode) return session;
  const full = fullTradingSession(session), premarket = calendarTimeToUtc(session.date, '04:00');
  return { ...session, mode, open: mode === 'overnight' ? full.open : mode === 'premarket' ? premarket : session.close,
    close: mode === 'overnight' ? premarket : mode === 'premarket' ? session.open : full.close };
}
export function currentSessionSegment<T extends { date: string; open: number; close: number }>(session: T, now: number): T & { mode?: SessionSegment } {
  return sessionSegment(session, now >= session.close ? 'afterhours' : now >= session.open ? undefined
    : now >= calendarTimeToUtc(session.date, '04:00') ? 'premarket' : 'overnight');
}
