import type { DataReads } from '../broker/reads';
import type { ScannerAsset } from '../core/market-data';
import type { ScannerBar, ScannerSession } from '../scanner/types';

const BAR_MS = 300_000, LOOKBACK = 7 * 86_400_000, FULL_REFRESH = 15 * 60_000;
interface History { bars: ScannerBar[]; through: number; loadedAt: number }

/** Shared execution reads. Quotes and account/write checks are never cached here. */
export class RobotData {
  private generation = 0;
  private assets: { at: number; values: ScannerAsset[] } | null = null;
  private assetRequest: Promise<ScannerAsset[]> | null = null;
  private calendars = new Map<string, { at: number; values: ScannerSession[] }>();
  private calendarRequests = new Map<string, Promise<{ at: number; values: ScannerSession[] }>>();
  private histories = new Map<string, History>();
  private historyRequests = new Map<string, Promise<ScannerBar[]>>();
  constructor(private readonly data: DataReads, private readonly signal: AbortSignal, private readonly now: () => number) {}
  private active(generation: number): void {
    if (this.signal.aborted || generation !== this.generation) throw new DOMException('Robot data request cancelled.', 'AbortError');
  }
  async eligibleAssets(): Promise<ScannerAsset[]> {
    const at = this.now(), generation = this.generation;
    if (this.assets && at >= this.assets.at && at - this.assets.at < 20_000) return this.assets.values;
    if (this.assetRequest) return this.assetRequest;
    const request = this.data.getEligibleAssets(this.signal).then(values => { this.active(generation); this.assets = { at, values }; return values; });
    this.assetRequest = request;
    try { return await request; } finally { if (this.assetRequest === request) this.assetRequest = null; }
  }
  async calendar(date: string): Promise<{ at: number; values: ScannerSession[] }> {
    const at = this.now(), cached = this.calendars.get(date), generation = this.generation;
    if (cached && at >= cached.at && at - cached.at < 60_000) return cached;
    const pending = this.calendarRequests.get(date); if (pending) return pending;
    const request = this.data.getCalendar(date, date, this.signal).then(values => {
      this.active(generation); const value = { at, values }; this.calendars.set(date, value);
      while (this.calendars.size > 8) this.calendars.delete(this.calendars.keys().next().value!);
      return value;
    });
    this.calendarRequests.set(date, request);
    try { return await request; } finally { if (this.calendarRequests.get(date) === request) this.calendarRequests.delete(date); }
  }
  async bars(symbol: string, date: string, overnight: boolean): Promise<ScannerBar[]> {
    const at = this.now(), through = Math.floor((at - 5000) / BAR_MS) * BAR_MS;
    const key = `${symbol}:${date}:${overnight}`, cached = this.histories.get(key), generation = this.generation;
    const reuse = cached && at >= cached.loadedAt && at - cached.loadedAt < FULL_REFRESH;
    if (reuse && cached.through === through) return cached.bars;
    const pending = this.historyRequests.get(key); if (pending) return pending;
    const floor = at - LOOKBACK;
    const start = reuse ? Math.max(floor, cached.through - 2 * BAR_MS) : floor;
    const request = this.data.getBars([symbol], { timeframe: '5Min', start, end: through, includeOvernight: overnight,
      maxPagesPerBatch: 3, maxBarsPerSymbol: 2200 }, this.signal).then(values => {
      this.active(generation);
      const merged = new Map<string, ScannerBar>();
      // The successful overlap replaces that range, including reported omissions.
      if (reuse) for (const bar of cached.bars) if (Date.parse(bar.t) >= floor && Date.parse(bar.t) < start) merged.set(bar.t, bar);
      for (const bar of values[symbol] ?? []) if (Date.parse(bar.t) >= floor && Date.parse(bar.t) + BAR_MS <= through) merged.set(bar.t, bar);
      const bars = [...merged.values()].sort((a, b) => Date.parse(a.t) - Date.parse(b.t)).slice(-2200);
      this.histories.delete(key); this.histories.set(key, { bars, through, loadedAt: reuse ? cached.loadedAt : at });
      while (this.histories.size > 300) this.histories.delete(this.histories.keys().next().value!);
      return bars;
    });
    this.historyRequests.set(key, request);
    try { return await request; } finally { if (this.historyRequests.get(key) === request) this.historyRequests.delete(key); }
  }
  clear(): void {
    this.generation++; this.assets = null; this.assetRequest = null; this.calendars.clear(); this.calendarRequests.clear(); this.histories.clear(); this.historyRequests.clear();
  }
}
