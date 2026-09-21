type Timestamp = Date | string | number;

/** Display time follows the browser; exchange-session calculations stay separate. */
export const localTimeZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone;

function format(value: Timestamp, options: Intl.DateTimeFormatOptions): string {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('en-US', options).format(date) : '—';
}

export function formatLocalTime(value: Timestamp, seconds = false, withZone = false): string {
  return format(value, {
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    ...(seconds ? { second: '2-digit' } : {}),
    ...(withZone ? { timeZoneName: 'short' } : {}),
  });
}

export function formatLocalDate(value: Timestamp, includeYear = false): string {
  return format(value, { month: 'short', day: 'numeric', ...(includeYear ? { year: 'numeric' } : {}) });
}

export function formatLocalTimestamp(value: Timestamp, seconds = true): string {
  return format(value, {
    year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    ...(seconds ? { second: '2-digit' } : {}), timeZoneName: 'short',
  });
}
