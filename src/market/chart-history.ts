import type { MarketReads } from '../broker/reads';
import type { Bar, Timeframe } from '../core/types';
import { CHART_LOOKBACK, MAX_CHART_BARS } from '../core/bar-history';

/** Replaceable session history: bounded, revision-aware, and periodically refetched for splits. */
export class ChartHistory {
  private cache = new Map<string, { bars: Bar[]; loadedAt: number }>();
  private requests = new Map<string, Promise<Bar[]>>();
  private disposed = false;
  private generation = 0;
  constructor(private readonly read: MarketReads['getBars'], private readonly now: () => number = Date.now) {}
  async getBars(ticker: string, timeframe: Timeframe, options: { extendedHistory?: boolean; signal?: AbortSignal } = {}): Promise<Bar[]> {
    if (this.disposed) throw new Error('This chart session is closed.');
    const symbol = ticker.trim().toUpperCase(), key = `${symbol}:${timeframe}`, signal = options.signal;
    const pending = this.requests.get(key); if (pending && !signal) return pending;
    const load = async () => {
      const generation = this.generation;
      const now = this.now(), floor = now - CHART_LOOKBACK[timeframe] * 86_400_000, cached = this.cache.get(key);
      const reuse = cached && now >= cached.loadedAt && now - cached.loadedAt < 15 * 60_000 && cached.bars.length > 0;
      const overlap = reuse ? Date.parse(cached.bars[Math.max(0, cached.bars.length - 2)].t) : floor;
      const recent = await this.read(symbol, timeframe, { extendedHistory: true, start: new Date(Math.max(floor, overlap)).toISOString(), signal });
      if (this.disposed || signal?.aborted || generation !== this.generation) throw new DOMException('Chart request cancelled.', 'AbortError');
      const merged = new Map<string, Bar>();
      if (reuse) for (const bar of cached.bars) if (Date.parse(bar.t) >= floor) merged.set(bar.t, bar);
      for (const bar of recent) if (Date.parse(bar.t) >= floor) merged.set(bar.t, bar);
      const bars = [...merged.values()].sort((a, b) => Date.parse(a.t) - Date.parse(b.t)).slice(-MAX_CHART_BARS);
      this.cache.delete(key); this.cache.set(key, { bars, loadedAt: reuse ? cached.loadedAt : now });
      while (this.cache.size > 12) this.cache.delete(this.cache.keys().next().value!);
      return bars;
    };
    const request = load(); this.requests.set(key, request);
    try { return await request; } finally { if (this.requests.get(key) === request) this.requests.delete(key); }
  }
  clear(): void { this.generation++; this.cache.clear(); this.requests.clear(); }
  dispose(): void { this.disposed = true; this.clear(); }
}
