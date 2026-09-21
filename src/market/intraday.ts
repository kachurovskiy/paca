import type { Bar } from '../core/types';

const marketTime = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

function sessionTime(timestamp: string): { date: string; minute: number } | null {
  const time = Date.parse(timestamp);
  if (!Number.isFinite(time)) return null;
  const parts = Object.fromEntries(marketTime.formatToParts(time).map(part => [part.type, part.value]));
  const minute = Number(parts.hour) * 60 + Number(parts.minute) - 570;
  if (parts.weekday === 'Sat' || parts.weekday === 'Sun' || minute < 0 || minute >= 390) return null;
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minute };
}

/** Minutes since 09:30 ET, or null outside the normal weekday regular session. */
export function regularSessionMinute(timestamp: string): number | null {
  return sessionTime(timestamp)?.minute ?? null;
}

/** The most recent available session date, including on weekends and before market open. */
export function intradaySessionDate(bars: readonly Bar[]): string | null {
  let latest: string | null = null;
  for (const bar of bars) {
    const date = sessionTime(bar.t)?.date;
    if (date && (!latest || date > latest)) latest = date;
  }
  return latest;
}

/** Actual bars from one NY regular session; no synthetic points or previous-day tail. */
export function latestIntradaySession(bars: readonly Bar[]): Bar[] {
  let latest = '';
  const session = new Map<number, Bar>();
  for (const bar of bars) {
    const time = sessionTime(bar.t);
    if (!time || time.date < latest) continue;
    if (time.date > latest) {
      latest = time.date;
      session.clear();
    }
    session.set(Date.parse(bar.t), bar);
  }
  return [...session.values()].sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
}
