import { describe, expect, it, vi } from 'vitest';
import { ScannerCache } from './cache';
import type { ScannerAsset, ScannerBarsRequest } from '../core/market-data';
import { loadLiquidityUniverse, type LiquidityProgress } from './universe';
import type { ScannerBar, ScannerSession } from '../scanner/types';

const today: ScannerSession = { date: '2026-09-17', open: Date.parse('2026-09-17T13:30:00Z'), close: Date.parse('2026-09-17T20:00:00Z') };
const previous: ScannerSession[] = [];
for (let time = today.open - 86_400_000; previous.length < 20; time -= 86_400_000) {
  if (![0, 6].includes(new Date(time).getUTCDay())) previous.unshift({ date: new Date(time).toISOString().slice(0, 10), open: time, close: time + 390 * 60_000 });
}
const now = () => today.open + 60_000;
const assets = (count: number): ScannerAsset[] => Array.from({ length: count }, (_, index) => ({ symbol: `S${String(index).padStart(5, '0')}`, id: `listing-${index}`, name: 'Stock', exchange: 'NASDAQ' }));
const daily = (session: ScannerSession, dollars = 1000): ScannerBar => ({ t: new Date(session.open - 570 * 60_000).toISOString(), o: 10, h: 11, l: 9, c: 10, v: dollars / 10, vw: 10 });
const history = (symbols: string[]) => Object.fromEntries(symbols.map(symbol => [symbol, previous.map(session => daily(session, Number(symbol.slice(1)) + 1))]));
const flush = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); };

describe('progressive daily liquidity universe', () => {
  it('bounds background workers and publishes completed batches while slower requests remain pending', async () => {
    const jobs: { symbols: string[]; finish: () => void }[] = [];
    let active = 0, maximum = 0;
    const getBars = vi.fn((symbols: string[]) => new Promise<Record<string, ScannerBar[]>>(resolve => {
      active++; maximum = Math.max(active, maximum);
      jobs.push({ symbols, finish: () => { active--; resolve(history(symbols)); } });
    }));
    const progress: LiquidityProgress[] = [];
    const loading = loadLiquidityUniverse({ getBars }, new ScannerCache(), assets(1201), previous, today, 3, now, undefined, value => progress.push(value));
    expect(jobs).toHaveLength(2);
    expect(jobs.every(job => job.symbols.length === 300)).toBe(true);
    jobs[0].finish(); await flush();
    expect(progress.at(-1)).toEqual({ symbols: ['S00299', 'S00298', 'S00297'], processed: 300, total: 1201, complete: false });
    expect(jobs).toHaveLength(3);
    jobs[2].finish(); await flush();
    jobs[1].finish(); await flush();
    jobs[3].finish(); await flush();
    jobs[4].finish();
    expect(await loading).toEqual(['S01200', 'S01199', 'S01198']);
    expect(maximum).toBe(2);
    expect(progress.map(value => value.processed)).toEqual([0, 300, 600, 900, 1200, 1201]);
    expect(progress.at(-1)?.complete).toBe(true);
  });

  it('resumes completed batches after a failed request within the session, independent of the result limit', async () => {
    const cache = new ScannerCache();
    const jobs: { finish: () => void; fail: () => void }[] = [];
    const firstApi = { getBars: vi.fn((symbols: string[], _options: ScannerBarsRequest, signal?: AbortSignal) => new Promise<Record<string, ScannerBar[]>>((resolve, reject) => {
      jobs.push({ finish: () => resolve(history(symbols)), fail: () => reject(new Error('Offline')) });
      signal?.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true });
    })) };
    const loading = loadLiquidityUniverse(firstApi, cache, assets(601), previous, today, 10, now);
    jobs[0].finish(); await flush();
    jobs[1].fail();
    await expect(loading).rejects.toThrow('Offline');
    const retryApi = { getBars: vi.fn(async (symbols: string[]) => history(symbols)) };
    const progress: LiquidityProgress[] = [];
    expect(await loadLiquidityUniverse(retryApi, cache, assets(601), previous, today, 3, now, undefined, value => progress.push(value))).toEqual(['S00600', 'S00599', 'S00598']);
    expect(progress[0].processed).toBe(300);
    expect(retryApi.getBars.mock.calls.flatMap(([symbols]) => symbols)).toHaveLength(301);
    const cachedApi = { getBars: vi.fn(async (symbols: string[]) => history(symbols)) };
    expect(await loadLiquidityUniverse(cachedApi, cache, assets(601).reverse(), previous, today, 1, now)).toEqual(['S00600']);
    expect(cachedApi.getBars).not.toHaveBeenCalled();
  });

  it('does not checkpoint or publish an aborted batch even if its adapter resolves after cancellation', async () => {
    const controller = new AbortController();
    let finish!: (value: Record<string, ScannerBar[]>) => void;
    const getBars = vi.fn(() => new Promise<Record<string, ScannerBar[]>>(resolve => { finish = resolve; }));
    const progress: LiquidityProgress[] = [];
    const loading = loadLiquidityUniverse({ getBars }, new ScannerCache(), assets(1), previous, today, 1, now, controller.signal, value => progress.push(value));
    controller.abort(); finish(history(['S00000']));
    await expect(loading).rejects.toMatchObject({ name: 'AbortError' });
    expect(progress.map(value => value.processed)).toEqual([0]);
    const retryApi = { getBars: vi.fn(async (symbols: string[]) => history(symbols)) };
    await loadLiquidityUniverse(retryApi, new ScannerCache(), assets(1), previous, today, 1, now);
    expect(retryApi.getBars).toHaveBeenCalledTimes(1);
  });

  it('orders by all requested prior sessions, excludes current/out-of-range dates, and never invents missing liquidity', async () => {
    const symbols = assets(5);
    const histories = history(symbols.map(asset => asset.symbol));
    histories.S00000 = previous.map((session, index) => daily(session, index === 0 ? 1000 : 1));
    histories.S00001 = previous.map(session => daily(session, 20));
    histories.S00002 = [daily(today, 1e12), daily({ ...previous[0], open: previous[0].open - 86_400_000 }, 1e12)];
    histories.S00003 = previous.map(session => ({ ...daily(session), vw: null }));
    histories.S00004 = [];
    const getBars = vi.fn(async () => histories);
    expect(await loadLiquidityUniverse({ getBars }, new ScannerCache(), symbols, previous, today, 5, now)).toEqual(['S00000', 'S00001']);
    expect(getBars).toHaveBeenCalledWith(symbols.map(asset => asset.symbol), { start: previous[0].open - 12 * 3_600_000, end: today.open, timeframe: '1Day' }, expect.any(AbortSignal));
  });

  it('does not reuse checkpoints for changed listing identities or historical sessions', async () => {
    const cache = new ScannerCache();
    const api = { getBars: vi.fn(async (symbols: string[]) => history(symbols)) };
    await loadLiquidityUniverse(api, cache, assets(2), previous, today, 2, now);
    api.getBars.mockClear();
    await loadLiquidityUniverse(api, cache, [{ ...assets(2)[0], id: 'replacement-listing' }, assets(2)[1]], previous, today, 2, now);
    expect(api.getBars).toHaveBeenCalledTimes(1);
    api.getBars.mockClear();
    await loadLiquidityUniverse(api, cache, assets(2), previous.slice(1), today, 2, now);
    expect(api.getBars).toHaveBeenCalledTimes(1);
  });

  it('validates cached dollar values before using them', async () => {
    const cache = new ScannerCache();
    const api = { getBars: vi.fn(async (symbols: string[]) => history(symbols)) };
    await loadLiquidityUniverse(api, cache, assets(1), previous, today, 1, now);
    const get = cache.get.bind(cache);
    vi.spyOn(cache, 'get').mockImplementation((key, at) => { const value = get<Record<string, unknown>>(key, at); return value ? { ...value, dollars: ['incorrect'] } : null; });
    api.getBars.mockClear();
    expect(await loadLiquidityUniverse(api, cache, assets(1), previous, today, 1, now)).toEqual(['S00000']);
    expect(api.getBars).toHaveBeenCalledTimes(1);
  });
});
