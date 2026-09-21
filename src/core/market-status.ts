import type { MarketClock } from './types';

export interface MarketStatus {
  status: string;
  isOpen: boolean;
  countdown: string;
  eventTime: string | null;
}

function duration(remaining: number): string {
  if (remaining < 60_000) return '<1m';
  const totalMinutes = Math.ceil(remaining / 60_000);
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor(totalMinutes / 60) % 24;
  const minutes = totalMinutes % 60;
  if (days) return `${days}d ${hours}h ${String(minutes).padStart(2, '0')}m`;
  if (hours) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  return `${minutes}m`;
}

/** Display the broker's next market boundary without predicting a new market state. */
export function marketStatus(clock: MarketClock | null, now = Date.now()): MarketStatus {
  if (!clock || !Number.isFinite(now) || !Number.isFinite(Date.parse(clock.timestamp)) || typeof clock.isOpen !== 'boolean') {
    return { status: 'Market status unavailable', isOpen: false, countdown: 'Schedule unavailable', eventTime: null };
  }

  const status = clock.isOpen ? 'US market open' : 'US market closed';
  const eventTime = clock.isOpen ? clock.nextClose : clock.nextOpen;
  const deadline = Date.parse(eventTime);
  if (!Number.isFinite(deadline)) {
    return { status, isOpen: clock.isOpen, countdown: 'Schedule unavailable', eventTime: null };
  }

  const remaining = deadline - now;
  if (remaining <= 0) {
    return { status: 'Updating market status', isOpen: false, countdown: '', eventTime: null };
  }

  return {
    status,
    isOpen: clock.isOpen,
    countdown: `${clock.isOpen ? 'Closes' : 'Opens'} in ${duration(remaining)}`,
    eventTime,
  };
}
