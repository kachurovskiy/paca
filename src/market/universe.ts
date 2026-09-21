const DAILY_BATCH_SIZE = 300;
import { type DataReads } from '../broker/reads';
import { type ScannerAsset } from '../core/market-data';
import type { ScannerCache } from './cache';
import type { ScannerBar, ScannerSession } from '../scanner/types';

export interface LiquidityProgress { symbols: string[]; processed: number; total: number; complete: boolean }
interface LiquidityCheckpoint { identity: string; dollars: (number | null)[]; coverage: string[]; asOf: number }
export interface LiquidityObservation {
  symbol: string; meanDailyDollars: number | null; observedDates: string[]; asOf: number;
}
export interface LiquiditySnapshot { symbols: string[]; observations: LiquidityObservation[] }
const exchangeDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
const abortError = () => new DOMException('Scanner liquidity loading cancelled.', 'AbortError');

function hash(value: string): string {
  let result = 2166136261;
  for (let index = 0; index < value.length; index++) result = Math.imul(result ^ value.charCodeAt(index), 16777619);
  return (result >>> 0).toString(36);
}

function dailyDollars(bars: readonly ScannerBar[], dates: Set<string>): { mean: number | null; dates: string[] } {
  const days = new Map<string, number>();
  for (const bar of bars) {
    const time = Date.parse(bar.t);
    if (!Number.isFinite(time) || !Number.isFinite(bar.vw) || bar.vw! <= 0 || !Number.isFinite(bar.v) || bar.v <= 0) continue;
    const parts = Object.fromEntries(exchangeDate.formatToParts(time).map(part => [part.type, part.value]));
    const date = `${parts.year}-${parts.month}-${parts.day}`;
    const dollars = bar.v * bar.vw!;
    if (dates.has(date) && Number.isFinite(dollars)) days.set(date, dollars);
  }
  if (!days.size) return { mean: null, dates: [] };
  const mean = [...days.values()].reduce((sum, dollars) => sum + dollars / days.size, 0);
  return { mean: Number.isFinite(mean) && mean > 0 ? mean : null, dates: [...days.keys()].sort() };
}

/** Progressive liquidity hints, never qualification. Checkpoint only complete REST batches. */
export async function loadLiquidityUniverse(
  api: Pick<DataReads, 'getBars'>, cache: ScannerCache, assets: readonly ScannerAsset[],
  previousSessions: readonly ScannerSession[], today: ScannerSession, limit: number, now: () => number,
  signal?: AbortSignal, onProgress?: (progress: LiquidityProgress) => void,
): Promise<string[]> {
  return (await loadLiquiditySnapshot(api, cache, assets, previousSessions, today, limit, now, signal, onProgress)).symbols;
}

/** The scanner and v2 share neutral ordering and provenance, never trend qualification. */
export async function loadLiquiditySnapshot(
  api: Pick<DataReads, 'getBars'>, cache: ScannerCache, assets: readonly ScannerAsset[],
  previousSessions: readonly ScannerSession[], today: ScannerSession, limit: number, now: () => number,
  signal?: AbortSignal, onProgress?: (progress: LiquidityProgress) => void,
): Promise<LiquiditySnapshot> {
  if (!Number.isInteger(limit) || limit < 1) throw new Error('Invalid scanner liquidity universe limit.');
  const previous = [...new Map(previousSessions.filter(session => session.close < today.open).map(session => [session.date, session])).values()].sort((a, b) => a.open - b.open);
  if (!previous.length) throw new Error('No previous exchange sessions are available for liquidity ordering.');
  const eligible = [...new Map(assets.map(asset => [asset.symbol, asset])).values()].sort((a, b) => a.symbol.localeCompare(b.symbol));
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) controller.abort();
  const active = () => { if (controller.signal.aborted) throw abortError(); };
  const dates = new Set(previous.map(session => session.date));
  const metadata = JSON.stringify(['v2', 'sip', 'split', today.date, today.open, today.close, previous.map(session => [session.date, session.open, session.close])]);
  const liquidity = new Map<string, number>();
  const observations = new Map<string, LiquidityObservation>();
  const pending: { symbols: string[]; identity: string; key: string }[] = [];
  let processed = 0, nextBatch = 0, failure: unknown;
  const ranking = () => [...liquidity].sort(([symbolA, a], [symbolB, b]) => b - a || symbolA.localeCompare(symbolB)).slice(0, limit).map(([symbol]) => symbol);
  const publish = () => onProgress?.({ symbols: ranking(), processed, total: eligible.length, complete: processed === eligible.length });
  const accept = (symbols: string[], saved: LiquidityCheckpoint) => {
    symbols.forEach((symbol, index) => {
      if (saved.dollars[index] !== null) liquidity.set(symbol, saved.dollars[index]!);
      observations.set(symbol, { symbol, meanDailyDollars: saved.dollars[index],
        observedDates: previous.filter((_session, day) => saved.coverage[index][day] === '1').map(session => session.date), asOf: saved.asOf });
    });
    processed += symbols.length;
  };
  try {
    active();
    for (let offset = 0; offset < eligible.length; offset += DAILY_BATCH_SIZE) {
      const group = eligible.slice(offset, offset + DAILY_BATCH_SIZE);
      const symbols = group.map(asset => asset.symbol);
      // Store the exact identity too, so even a hash collision cannot reuse another
      // batch, listing, history range, or adjustment. Result limits are not inputs.
      const identity = JSON.stringify([metadata, group.map(asset => [asset.symbol, asset.id])]);
      const key = `liquidity:v2:${today.date}:${hash(identity)}`;
      const saved = cache.get<LiquidityCheckpoint>(key, now());
      if (saved?.identity === identity && Number.isFinite(saved.asOf) && saved.asOf >= today.open && saved.asOf <= now()
        && Array.isArray(saved.dollars) && saved.dollars.length === symbols.length
        && saved.dollars.every(value => value === null || typeof value === 'number' && Number.isFinite(value) && value > 0)
        && Array.isArray(saved.coverage) && saved.coverage.length === symbols.length
        && saved.coverage.every((mask, index) => typeof mask === 'string' && mask.length === previous.length && /^[01]+$/.test(mask)
          && (saved.dollars[index] === null ? !mask.includes('1') : mask.includes('1')))) accept(symbols, saved);
      else pending.push({ symbols, identity, key });
    }
    publish();
    // Leave a request slot for foreground discovery and minute-history work.
    await Promise.all(Array.from({ length: Math.min(2, pending.length) }, async () => {
      try {
        while (!controller.signal.aborted && nextBatch < pending.length) {
          const group = pending[nextBatch++];
          const bars = await api.getBars(group.symbols, { start: previous[0].open - 12 * 3_600_000, end: today.open, timeframe: '1Day' }, controller.signal);
          active();
          const summaries = group.symbols.map(symbol => dailyDollars(bars[symbol] ?? [], dates));
          const saved: LiquidityCheckpoint = { identity: group.identity, dollars: summaries.map(value => value.mean),
            coverage: summaries.map(value => previous.map(session => value.mean !== null && value.dates.includes(session.date) ? '1' : '0').join('')), asOf: now() };
          cache.set(group.key, saved, today.close, now());
          accept(group.symbols, saved);
          publish();
        }
      } catch (error) {
        if (failure === undefined) failure = error;
        controller.abort();
      }
    }));
    if (failure !== undefined) throw failure;
    active();
    return { symbols: ranking(), observations: eligible.map(asset => observations.get(asset.symbol)!) };
  } finally { signal?.removeEventListener('abort', abort); }
}

