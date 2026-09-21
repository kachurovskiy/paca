import { describe, expect, it, vi } from 'vitest';
import { Scanner } from './service';
import { ScannerBarStore, ScannerCache } from '../market/cache';
import { DEFAULT_SCANNER_CONFIG, QuoteSampler } from './engine';
import type { ScannerDataApi } from '../broker/market-data';
import type { ScannerBarsRequest } from '../core/market-data';
import type { ScannerBar, ScannerSession } from './types';
import type { AlpacaStream } from '../broker/stream';

const MINUTE = 60_000;
const open = Date.parse('2026-09-18T13:30:00Z');
const session: ScannerSession = { date: '2026-09-18', open, close: open + 390 * MINUTE };
const bars = (count: number): ScannerBar[] => Array.from({ length: count }, (_, index) => ({
  t: new Date(open + index * MINUTE).toISOString(), o: 100, h: 101, l: 99, c: 100.5, v: 20_000, vw: 100.25,
}));

function fixture(initial: Record<string, ScannerBar[]>, missing: Record<string, number[]> = {}) {
  let now = open + 60 * MINUTE + 6000;
  const store = new ScannerBarStore(open, session.close);
  for (const [symbol, rows] of Object.entries(initial)) store.mergeRest(symbol, rows, 0);
  const getBars = vi.fn(async (symbols: string[], request: ScannerBarsRequest) => Object.fromEntries(symbols.map(symbol => [symbol,
    bars(Math.floor((now - open) / MINUTE)).filter((bar, minute) => Date.parse(bar.t) >= request.start && Date.parse(bar.t) < request.end && !missing[symbol]?.includes(minute)),
  ])));
  const api = { getBars, dispose: vi.fn() };
  const stream = { removeOwner: vi.fn() };
  const scanner = new Scanner(stream as unknown as AlpacaStream, vi.fn(), () => now,
    { api: api as unknown as ScannerDataApi, cache: new ScannerCache(), config: DEFAULT_SCANNER_CONFIG });
  Reflect.set(scanner, 'store', store);
  scanner.snapshot.session = session;
  const backfill = Reflect.get(scanner, 'backfill') as (symbols: string[], session: ScannerSession, signal: AbortSignal, active: () => void) => Promise<void>;
  return { scanner, store, getBars, setNow: (value: number) => { now = value; }, run: (symbols: string[]) => backfill.call(scanner, symbols, session, new AbortController().signal, () => {}) };
}

describe('scanner current-session backfill scheduling', () => {
  it('refreshes recent bars first and excludes healthy symbols from older gap repairs', async () => {
    const current = bars(60), sparse = current.filter((_, minute) => minute !== 3);
    const { scanner, getBars, store, run } = fixture({ HEALTHY: current, SPARSE: sparse }, { SPARSE: [3] });
    try {
      await run(['HEALTHY', 'SPARSE', 'NEW']);
      expect(getBars).toHaveBeenCalledTimes(2);
      expect(getBars.mock.calls[0].slice(0, 2)).toEqual([['HEALTHY', 'SPARSE'], { start: open + 57 * MINUTE, end: open + 60 * MINUTE + 6000, timeframe: '1Min' }]);
      expect(getBars.mock.calls[1][0]).toEqual(['SPARSE', 'NEW']);
      expect(getBars.mock.calls[1][1].start).toBe(open);
      expect(store.bars('NEW')).toHaveLength(60);
      expect(store.bars('SPARSE')).toHaveLength(59);
    } finally { scanner.dispose(); }
  });

  it('bootstraps new symbols in one pass without duplicate recent-bar requests', async () => {
    const { scanner, getBars, store, run } = fixture({});
    try {
      await run(['NEW', 'ALSO']);
      expect(getBars).toHaveBeenCalledTimes(1);
      expect(getBars.mock.calls[0][1].start).toBe(open);
      expect(store.bars('NEW')).toHaveLength(60);
    } finally { scanner.dispose(); }
  });

  it('continues fresh reads but defers repeated downloads of a known old hole, and retries on recovery', async () => {
    const { scanner, getBars, setNow, run } = fixture({ SPARSE: bars(60).filter((_, minute) => minute !== 3) }, { SPARSE: [3] });
    try {
      await run(['SPARSE']);
      expect(getBars).toHaveBeenCalledTimes(2);
      getBars.mockClear();
      setNow(open + 62 * MINUTE + 6000);
      await run(['SPARSE']);
      expect(getBars).toHaveBeenCalledTimes(1);
      expect(getBars.mock.calls[0][1].start).toBe(open + 59 * MINUTE);
      getBars.mockClear();
      Reflect.set(scanner, 'recovering', true);
      await run(['SPARSE']);
      expect(getBars).toHaveBeenCalledTimes(2);
      expect(getBars.mock.calls[1][1].start).toBe(open + 3 * MINUTE);
      Reflect.set(scanner, 'recovering', false);
      getBars.mockClear();
      setNow(open + 67 * MINUTE + 6000);
      await run(['SPARSE']);
      expect(getBars).toHaveBeenCalledTimes(2);
    } finally { scanner.dispose(); }
  });

  it('does not repair a minute that is still inside the completed-bar grace window', async () => {
    const { scanner, getBars, setNow, run } = fixture({ HEALTHY: bars(59) }, { HEALTHY: [59] });
    try {
      setNow(open + 60 * MINUTE + 4000);
      await run(['HEALTHY']);
      expect(getBars).toHaveBeenCalledTimes(1);
      expect(getBars.mock.calls[0][1].start).toBe(open + 56 * MINUTE);
    } finally { scanner.dispose(); }
  });

  it('keeps checking recent bars for a previously empty symbol while deferring its old history gaps', async () => {
    const { scanner, getBars, store, setNow, run } = fixture({}, { QUIET: Array.from({ length: 60 }, (_, minute) => minute) });
    try {
      await run(['QUIET']);
      expect(store.bars('QUIET')).toHaveLength(0);
      getBars.mockClear();
      setNow(open + 62 * MINUTE + 6000);
      await run(['QUIET']);
      expect(getBars).toHaveBeenCalledTimes(1);
      expect(getBars.mock.calls[0][1].start).toBe(open + 59 * MINUTE);
      expect(store.bars('QUIET')).toHaveLength(2);
    } finally { scanner.dispose(); }
  });

  it('puts the quote shortlist ahead of the broad universe when refreshing multiple batches', async () => {
    const symbols = Array.from({ length: 52 }, (_, index) => `S${index}`);
    const { scanner, getBars, run } = fixture(Object.fromEntries(symbols.map(symbol => [symbol, bars(60)])));
    Reflect.set(scanner, 'quotes', new Map([['S51', new QuoteSampler()]]));
    try {
      await run(symbols);
      expect(getBars).toHaveBeenCalledTimes(2);
      expect(getBars.mock.calls[0][0][0]).toBe('S51');
      expect(getBars.mock.calls[0][0]).toHaveLength(50);
      expect(getBars.mock.calls[1][0]).toHaveLength(2);
    } finally { scanner.dispose(); }
  });
});
