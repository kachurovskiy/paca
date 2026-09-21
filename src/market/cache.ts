import type { ScannerBar } from '../scanner/types';

/** Bounded replaceable session data. Never opens persistent cache namespaces. */
export class ScannerCache {
  private values = new Map<string, { value: unknown; expires: number; size: number }>();
  private size = 0;
  readonly warning = '';
  hits = 0;
  constructor(private readonly maximumBytes = 2_500_000) {}
  get<T>(key: string, now: number): T | null {
    const item = this.values.get(key);
    if (!item) return null;
    if (item.expires <= now) { this.remove(key); return null; }
    this.values.delete(key); this.values.set(key, item); this.hits++;
    return item.value as T;
  }
  set(key: string, value: unknown, expires: number, now: number): void {
    this.remove(key);
    const size = JSON.stringify(value).length * 2;
    if (size > this.maximumBytes || expires <= now) return;
    this.values.set(key, { value: structuredClone(value), expires, size }); this.size += size;
    while (this.size > this.maximumBytes) this.remove(this.values.keys().next().value!);
  }
  invalidate(prefix: string, _now: number): void {
    for (const key of this.values.keys()) if (key.startsWith(prefix)) this.remove(key);
  }
  private remove(key: string): void { this.size -= this.values.get(key)?.size ?? 0; this.values.delete(key); }
}

interface StoredBar { bar: ScannerBar; sequence: number; revised: boolean; source: 'rest' | 'live' }
/** A single SIP/session store. Request watermarks protect events arriving during REST reads. */
export class ScannerBarStore {
  private symbols = new Map<string, Map<number, StoredBar>>();
  private restCoverage = new Map<string, number>();
  private sequence = 0;
  constructor(readonly sessionOpen: number, readonly sessionClose: number) {}
  watermark(): number { return this.sequence; }
  mergeLive(symbol: string, bar: ScannerBar, revised: boolean): boolean {
    const time = Date.parse(bar.t);
    if (!this.inSession(time)) return false;
    const series = this.series(symbol), old = series.get(time);
    // A late duplicate original minute bar must never undo an updated bar.
    if (old?.revised && !revised) return false;
    if (old && ['o', 'h', 'l', 'c', 'v', 'vw'].every(key => old.bar[key as keyof ScannerBar] === bar[key as keyof ScannerBar])) {
      old.revised ||= revised; old.source = 'live'; old.sequence = ++this.sequence;
      return false;
    }
    series.set(time, { bar, revised, sequence: ++this.sequence, source: 'live' });
    return true;
  }
  /** Coverage is supplied only after all REST pages succeed, through completed minutes. */
  mergeRest(symbol: string, bars: readonly ScannerBar[], requestWatermark: number, coverage?: { start: number; end: number }): void {
    const series = this.series(symbol);
    for (const bar of bars) {
      const time = Date.parse(bar.t);
      if (!this.inSession(time)) continue;
      const old = series.get(time);
      if (old && old.sequence > requestWatermark) continue;
      // REST carries no revision sequence. A received updatedBar is authoritative
      // for that minute even when an eventually-consistent REST read starts later.
      if (old?.source === 'live' && old.revised) continue;
      series.set(time, { bar, revised: old?.revised ?? false, sequence: requestWatermark, source: 'rest' });
    }
    if (coverage) {
      let through = this.coveredThrough(symbol);
      // Actual bars can bridge disjoint REST ranges; unobserved gaps cannot.
      while (through < coverage.start && series.has(through)) through += 60_000;
      if (through >= coverage.start) this.restCoverage.set(symbol, Math.max(through, Math.min(coverage.end, this.sessionClose)));
    }
  }
  coveredThrough(symbol: string): number { return this.restCoverage.get(symbol) ?? this.sessionOpen; }
  bars(symbol: string): ScannerBar[] {
    return [...(this.symbols.get(symbol)?.values() ?? [])].map(value => value.bar).sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
  }
  retain(symbols: Set<string>): void {
    for (const symbol of this.symbols.keys()) if (!symbols.has(symbol)) { this.symbols.delete(symbol); this.restCoverage.delete(symbol); }
  }
  private inSession(time: number): boolean { return Number.isFinite(time) && time >= this.sessionOpen && time < this.sessionClose && (time - this.sessionOpen) % 60_000 === 0; }
  private series(symbol: string): Map<number, StoredBar> {
    let result = this.symbols.get(symbol);
    if (!result) { result = new Map(); this.symbols.set(symbol, result); }
    return result;
  }
}
