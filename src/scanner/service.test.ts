import { sessionSegment, type SessionSegment } from '../core/exchange-session';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Scanner, cheapTrend, selectScannerCandidates } from './service';
import { DEFAULT_SCANNER_CONFIG, buildVolumeProfile, evaluateScanner } from './engine';
import { ScannerCache } from '../market/cache';
import type { ScannerDataApi } from '../broker/market-data';
import type { AlpacaStream } from '../broker/stream';
import type { StreamHandlers } from '../core/stream';
import type { ScannerBar, ScannerConfig, ScannerSession } from './types';

const MINUTE = 60_000, DAY = 86_400_000;
const open = Date.parse('2026-09-17T13:30:00Z');
const today: ScannerSession = { date: '2026-09-17', open, close: open + 390 * MINUTE };
const sessions: ScannerSession[] = [];
for (let i = 1; sessions.length < 20; i++) {
  const time = open - i * DAY, day = new Date(time).getUTCDay();
  if (day !== 0 && day !== 6) sessions.unshift({ date: new Date(time).toISOString().slice(0, 10), open: time, close: time + 390 * MINUTE });
}
function bars(session: ScannerSession, count = 390): ScannerBar[] {
  const live = session.date === today.date;
  return Array.from({ length: count }, (_, i) => ({ t: new Date(session.open + i * MINUTE).toISOString(), o: 100 + i * 0.02, c: 100 + (i + 1) * 0.02, h: 100 + (i + 1) * 0.02 + 0.03, l: 100 + i * 0.02 - 0.03, v: live ? 30_000 : 10_000, vw: 100 + i * 0.02 + 0.01 }));
}
class FakeStream {
  handlers: Partial<StreamHandlers> = {};
  subscriptions: Record<string, unknown> = {};
  addListener(handlers: Partial<StreamHandlers>) { this.handlers = handlers; return () => { this.handlers = {}; }; }
  setOwnerSubscriptions(owner: string, values: unknown) { this.subscriptions[owner] = values; }
  removeOwner(owner: string) { delete this.subscriptions[owner]; }
}
function fixture(options: { calendar?: ScannerSession[]; segment?: SessionSegment; sparse?: boolean; failedHistory?: boolean; config?: Partial<ScannerConfig> } = {}) {
  const stream = new FakeStream();
  const calendar = options.calendar ?? [...sessions, today];
  const all = calendar.flatMap(regular => {
    const session = sessionSegment(regular, options.segment);
    const observed = bars(session, (session.close - session.open) / MINUTE)
      .map(bar => ({ ...bar, v: regular.date === calendar.at(-1)?.date ? 30_000 : 10_000 }))
      .filter((_, index) => !options.sparse || index % 5 !== 1);
    return [...(options.segment ? bars(regular) : []), ...observed];
  });
  const api = {
    getCalendar: vi.fn(async () => options.calendar ?? [...sessions, today]),
    getEligibleAssets: vi.fn(async (): Promise<import('../core/market-data').ScannerAsset[]> => [{ symbol: 'STEADY', id: 'asset-1', name: 'Steady', exchange: 'NASDAQ', overnightTradable: true }]),
    getBars: vi.fn(async (_symbols: string[], request: { start: number; end: number; timeframe: string }) => {
      if (request.timeframe === '1Day') return { STEADY: sessions.map(session => ({ ...bars(session, 1)[0], v: 3_900_000 })) };
      if (options.failedHistory && request.start < open) throw new Error('Historical page missing');
      return { STEADY: all.filter(bar => Date.parse(bar.t) >= request.start && Date.parse(bar.t) < request.end) };
    }),
    getDiscovery: vi.fn(async () => ({ symbols: [] as string[], warnings: [], updatedAt: Date.now(), mostActiveCount: 0, moversCount: 0 })),
    getSplitFingerprint: vi.fn(async () => ({ STEADY: 'none' })),
    getSnapshots: vi.fn(async () => ({ STEADY: { previousClose: 110 } })),
    dispose: vi.fn(),
  };
  const changed = vi.fn();
  const scanner = new Scanner(stream as unknown as AlpacaStream, changed, Date.now,
    { api: api as unknown as ScannerDataApi, cache: new ScannerCache(10_000), config: { ...DEFAULT_SCANNER_CONFIG, baseUniverseSize: 1, ...options.config } });
  return { scanner, api, stream, changed };
}
const scanners: Scanner[] = [];
afterEach(() => { scanners.splice(0).forEach(scanner => scanner.dispose()); vi.useRealTimers(); });
async function flush() { for (let i = 0; i < 50; i++) await Promise.resolve(); }
async function replaySeconds(stream: FakeStream, seconds: number, symbols = ['STEADY'], replaySession = today) {
  for (let i = 0; i < seconds; i++) {
    const next = Date.now() + 1000;
    for (const symbol of symbols) stream.handlers.onQuote?.({ symbol, timestamp: new Date(next - 1).toISOString(), bid: 101.19, ask: 101.21, bidSize: 10, askSize: 10 });
    const minute = Math.floor((next - replaySession.open) / MINUTE) - 1;
    if (minute >= 0) for (const symbol of symbols) stream.handlers.onBar?.({ ...bars(replaySession, minute + 1)[minute], symbol, revision: false });
    await vi.advanceTimersByTimeAsync(1000);
  }
}

describe('scanner service finalized-history replay with injected clock', () => {
  it('exposes every confirmed discovery beyond the ranked cutoff without admitting partial candidates', async () => {
    vi.useFakeTimers(); vi.setSystemTime(open + 60 * MINUTE + 6000);
    const { scanner, api, stream } = fixture({ config: { maxResults: 1, quoteShortlistSize: 2 } }); scanners.push(scanner);
    api.getEligibleAssets.mockResolvedValue(['STEADY', 'SECOND'].map(symbol => ({ symbol, id: symbol, name: symbol, exchange: 'NASDAQ' })));
    api.getDiscovery.mockResolvedValue({ symbols: ['STEADY', 'SECOND'], warnings: [], updatedAt: Date.now(), mostActiveCount: 2, moversCount: 0 });
    const getBars = api.getBars.getMockImplementation()!;
    api.getBars.mockImplementation(async (symbols, request) => { const result = await getBars(symbols, request); return { ...result, SECOND: result.STEADY }; });
    scanner.start(); await flush();
    expect(scanner.snapshot.reviewRows?.some(row => row.confirmed)).toBe(false);
    await replaySeconds(stream, 124, ['STEADY', 'SECOND']);
    expect(scanner.snapshot.rows).toHaveLength(1);
    expect(scanner.snapshot.reviewRows?.filter(row => row.confirmed).map(row => row.evaluation.symbol).sort()).toEqual(['SECOND', 'STEADY']);
    stream.handlers.onStatus?.('disconnected', 'Stream dropped');
    expect(scanner.snapshot.reviewRows?.every(row => !row.confirmed && row.evaluation.dataStatus === 'unavailable')).toBe(true);
  });

  it('keeps Watching symbols monitored outside discovery without taking its quote shortlist or ranking slots', async () => {
    vi.useFakeTimers(); vi.setSystemTime(open + 60 * MINUTE + 6000);
    const { scanner, api, stream } = fixture({ config: { maxResults: 1, quoteShortlistSize: 1 } }); scanners.push(scanner);
    api.getEligibleAssets.mockResolvedValue(['STEADY', 'WATCHED'].map(symbol => ({ symbol, id: symbol, name: symbol, exchange: 'NASDAQ' })));
    const getBars = api.getBars.getMockImplementation()!;
    api.getBars.mockImplementation(async (symbols, request) => {
      const result = await getBars(symbols, request);
      return request.timeframe === '1Day' ? result : { ...result, WATCHED: result.STEADY };
    });
    scanner.setReviewSymbols(['WATCHED']); scanner.start(); await flush();
    expect(stream.subscriptions['clean-uptrends']).toMatchObject({ bars: ['STEADY', 'WATCHED'], quotes: expect.arrayContaining(['STEADY', 'WATCHED']) });
    await replaySeconds(stream, 124, ['STEADY', 'WATCHED']);
    expect(scanner.snapshot.rows.map(row => row.evaluation.symbol)).toEqual(['STEADY']);
    expect(scanner.snapshot.reviewRows?.find(row => row.evaluation.symbol === 'WATCHED')).toMatchObject({ confirmed: false, evaluation: { qualified: true, dataStatus: 'ready' } });
    scanner.setReviewSymbols([]); await flush();
    expect(stream.subscriptions['clean-uptrends']).toMatchObject({ bars: ['STEADY'], quotes: ['STEADY'] });
    expect(scanner.snapshot.reviewRows?.map(row => row.evaluation.symbol)).toEqual(['STEADY']);
  });

  it('separates shortlist freshness and pending history from unscreened universe coverage', async () => {
    vi.useFakeTimers(); vi.setSystemTime(open + 60 * MINUTE + 6000);
    const { scanner, api } = fixture(); scanners.push(scanner);
    api.getEligibleAssets.mockResolvedValue(['STEADY', 'QUIET', 'STALE'].map(symbol => ({ symbol, id: symbol, name: symbol, exchange: 'NASDAQ' })));
    api.getDiscovery.mockResolvedValue({ symbols: ['STEADY', 'QUIET', 'STALE'], warnings: [], updatedAt: Date.now(), mostActiveCount: 3, moversCount: 0 });
    const original = api.getBars.getMockImplementation()!;
    api.getBars.mockImplementation(async (symbols, request) => {
      const values = await original(symbols, request);
      if (request.timeframe !== '1Min' || request.start < open) return values;
      const within = (bar: ScannerBar) => Date.parse(bar.t) >= request.start && Date.parse(bar.t) < request.end;
      return { ...values, QUIET: bars(today, 60).map(bar => ({ ...bar, o: 100, h: 100, l: 100, c: 100, vw: 100 })).filter(within), STALE: bars(today, 1).filter(within) };
    });
    scanner.start(); await flush();
    expect(scanner.snapshot.diagnostics).toMatchObject({ universeSize: 3, quoteShortlistSize: 1, historyReady: 1, historyPending: 0, historyUnrequested: 2, barsReady: 2, barLagSeconds: 6, worstUniverseBarLagSeconds: 3546 });
    expect(scanner.snapshot.diagnostics.exclusionCounts).toHaveProperty('Historical volume profile not requested; outside the quote shortlist', 1);
    expect(scanner.snapshot.candidates?.map(row => row.evaluation.symbol)).toEqual(['STEADY']);
  });

  it('evaluates and admits discovery candidates while broad daily liquidity requests are still pending', async () => {
    vi.useFakeTimers(); vi.setSystemTime(open + 60 * MINUTE + 6000);
    const { scanner, api, stream } = fixture(); scanners.push(scanner);
    const getBars = api.getBars.getMockImplementation()!;
    let release!: () => void;
    const pendingDaily = new Promise<void>(resolve => { release = resolve; });
    api.getBars.mockImplementation(async (symbols, request) => {
      if (request.timeframe === '1Day') await pendingDaily;
      return getBars(symbols, request);
    });
    api.getDiscovery.mockResolvedValue({ symbols: ['STEADY'], warnings: [], updatedAt: Date.now(), mostActiveCount: 1, moversCount: 0 });
    scanner.start(); await flush();
    expect(scanner.snapshot.diagnostics).toMatchObject({ universeSize: 1, baseUniverseSize: 0, historyReady: 1, liquidityProcessed: 0, liquidityComplete: false });
    await replaySeconds(stream, 124);
    expect(scanner.snapshot.rows.map(row => row.evaluation.symbol)).toEqual(['STEADY']);
    expect(scanner.snapshot.rows[0].state).toBe('Clean uptrend');
    expect(api.getBars.mock.calls.filter(([, request]) => request.timeframe === '1Day')).toHaveLength(1);
    release(); await flush();
    expect(scanner.snapshot.diagnostics).toMatchObject({ baseUniverseSize: 1, liquidityProcessed: 1, liquidityComplete: true });
  });

  it('starts scanning the first real liquidity batch when discovery is empty without waiting for the remaining assets', async () => {
    vi.useFakeTimers(); vi.setSystemTime(open + 60 * MINUTE + 6000);
    const { scanner, api } = fixture(); scanners.push(scanner);
    api.getEligibleAssets.mockResolvedValue([
      { symbol: 'STEADY', id: 'asset-1', name: 'Steady', exchange: 'NASDAQ', overnightTradable: true },
      ...Array.from({ length: 300 }, (_, index) => ({ symbol: `ZZ${index.toString().padStart(3, '0')}`, id: `extra-${index}`, name: 'Extra', exchange: 'NASDAQ' })),
    ]);
    const getBars = api.getBars.getMockImplementation()!;
    let release!: () => void;
    const pendingDaily = new Promise<void>(resolve => { release = resolve; });
    api.getBars.mockImplementation(async (symbols, request) => {
      if (request.timeframe === '1Day' && !symbols.includes('STEADY')) {
        await pendingDaily;
        return { STEADY: [] };
      }
      return getBars(symbols, request);
    });
    scanner.start(); await flush();
    expect(scanner.snapshot.diagnostics).toMatchObject({ universeSize: 1, historyReady: 1, liquidityProcessed: 300, liquidityTotal: 301, liquidityComplete: false });
    scanner.dispose();
    const before = JSON.stringify(scanner.snapshot);
    release(); await flush();
    expect(JSON.stringify(scanner.snapshot)).toBe(before);
  });

  it('finds a steady base-universe riser outside discovery lists at midday; warms quotes, admits distinct minutes and never uses orders', async () => {
    vi.useFakeTimers(); vi.setSystemTime(open + 60 * MINUTE + 6000);
    const { scanner, api, stream } = fixture(); scanners.push(scanner); scanner.start(); await flush();
    expect(scanner.snapshot.diagnostics.universeSize).toBe(1);
    expect(scanner.snapshot.diagnostics.historyReady).toBe(1);
    expect(scanner.snapshot.rows).toHaveLength(0);
    expect(scanner.snapshot.candidates?.map(row => row.evaluation.symbol)).toEqual(['STEADY']);
    await replaySeconds(stream, 124);
    expect(scanner.snapshot.rows.map(row => row.evaluation.symbol)).toEqual(['STEADY']);
    expect(scanner.snapshot.rows[0].evaluation.features.dailyChange).toBeLessThan(0);
    expect(scanner.snapshot.rows[0].evaluation.features.sessionRVOL).toBeCloseTo(3);
    expect(scanner.snapshot.rows[0].state).toBe('Clean uptrend');
    expect(api.getBars.mock.calls.filter(([, request]) => request.timeframe === '1Min' && request.start < open)).toHaveLength(1);
    expect(Object.keys(api).some(key => /order|position/i.test(key))).toBe(false);
    expect(stream.subscriptions['clean-uptrends']).toMatchObject({ bars: ['STEADY'], quotes: ['STEADY'], updatedBars: ['STEADY'] });
    // Independent hard freshness checks remove the row before another ranking minute.
    await vi.advanceTimersByTimeAsync(6000);
    expect(scanner.snapshot.rows).toHaveLength(0);
    expect(scanner.snapshot.diagnostics.qualifyingCount).toBe(0);
    expect(scanner.snapshot.recentRows?.map(row => row.evaluation.symbol)).toEqual(['STEADY']);
    expect(scanner.snapshot.recentRows?.[0].evaluation.reasons.join(' ')).toContain('Stale');
    expect(scanner.snapshot.candidates).toEqual([]);
    vi.setSystemTime(today.close + 1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(scanner.snapshot.recentRows).toEqual([]); // Expiry also runs when no live rankings can advance.
  });

  it('does not manufacture RVOL after a partial historical request', async () => {
    vi.useFakeTimers(); vi.setSystemTime(open + 60 * MINUTE + 6000);
    const { scanner, stream } = fixture({ failedHistory: true }); scanners.push(scanner); scanner.start(); await flush();
    await replaySeconds(stream, 124);
    expect(scanner.snapshot.rows).toEqual([]);
    expect(scanner.snapshot.diagnostics.historyReady).toBe(0);
    expect(scanner.snapshot.diagnostics.exclusionCounts).toHaveProperty('Historical volume profile is loading');
  });

  it('uses holiday/closed calendar without requesting universe data and moves into after-hours at an actual early close', async () => {
    vi.useFakeTimers(); vi.setSystemTime(open + 60 * MINUTE);
    const closed = fixture({ calendar: [] }); scanners.push(closed.scanner); closed.scanner.start(); await flush();
    expect(closed.scanner.snapshot.status).toBe('closed');
    expect(closed.api.getEligibleAssets).not.toHaveBeenCalled();
    const early = fixture({ calendar: [...sessions, { ...today, close: open + 61 * MINUTE }] });
    scanners.push(early.scanner); early.scanner.start(); await flush();
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(early.scanner.snapshot.status).not.toBe('closed');
    expect(early.scanner.snapshot.session).toMatchObject({ mode: 'afterhours', open: open + 61 * MINUTE });
    expect(early.scanner.snapshot.rows).toEqual([]);
  });

  it('invalidates split profiles, resets config streaks and releases only scanner subscriptions', async () => {
    vi.useFakeTimers(); vi.setSystemTime(open + 60 * MINUTE + 6000);
    const { scanner, api, stream } = fixture(); scanners.push(scanner); scanner.start(); await flush();
    await replaySeconds(stream, 124);
    api.getSplitFingerprint.mockResolvedValue({ STEADY: 'forward_splits:new-action' });
    await replaySeconds(stream, 120);
    expect(api.getBars.mock.calls.filter(([, request]) => request.start < open && request.timeframe === '1Min').length).toBeGreaterThanOrEqual(2);
    const version = scanner.snapshot.config.version;
    stream.subscriptions.manual = { quotes: ['PINNED'] };
    scanner.updateConfig({ enabled: false }); await flush();
    expect(scanner.snapshot.config.version).toBe(version + 1);
    expect(scanner.snapshot.rows).toEqual([]);
    expect(stream.subscriptions).toEqual({ manual: { quotes: ['PINNED'] } });
    scanner.dispose(); expect(api.dispose).not.toHaveBeenCalled();
  });

  it('disconnect clears live qualification and reconnect backfills before recovery', async () => {
    vi.useFakeTimers(); vi.setSystemTime(open + 60 * MINUTE + 6000);
    const { scanner, api, stream } = fixture(); scanners.push(scanner); scanner.start(); await flush();
    await replaySeconds(stream, 124);
    const requests = api.getBars.mock.calls.length;
    stream.handlers.onStatus?.('disconnected', 'Lost transport');
    expect(scanner.snapshot.rows).toEqual([]); expect(scanner.snapshot.status).toBe('error');
    stream.handlers.onStatus?.('ready', 'Recovered'); await flush();
    expect(api.getBars.mock.calls.length).toBeGreaterThan(requests);
    expect(scanner.snapshot.rows).toEqual([]); // Quote sampling and admission must warm again.
  });

  it('rejects scanner subscription failure without later history publishing live status', async () => {
    vi.useFakeTimers(); vi.setSystemTime(open + 60 * MINUTE + 6000);
    const { scanner, stream } = fixture(); scanners.push(scanner); scanner.start();
    stream.handlers.onSubscriptionError?.('clean-uptrends', 'Subscription capacity exceeded');
    await flush(); await replaySeconds(stream, 65);
    expect(scanner.snapshot.status).toBe('error'); expect(scanner.snapshot.rows).toEqual([]);
  });

  it('marks spread failures Fading at the same watermark and immediately invalidates known halts', async () => {
    vi.useFakeTimers(); vi.setSystemTime(open + 60 * MINUTE + 6000);
    const { scanner, stream } = fixture(); scanners.push(scanner); scanner.start(); await flush();
    await replaySeconds(stream, 124);
    stream.handlers.onQuote?.({ symbol: 'STEADY', timestamp: new Date(Date.now()).toISOString(), bid: 101, ask: 102, bidSize: 10, askSize: 10 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(scanner.snapshot.rows[0]?.state).toBe('Fading');
    expect(scanner.snapshot.rows[0]?.evaluation.qualified).toBe(false);
    expect(scanner.snapshot.diagnostics.qualifyingCount).toBe(0);
    stream.handlers.onTradingStatus?.({ symbol: 'STEADY', statusCode: 'H', message: 'Regulatory halt', timestamp: new Date(Date.now()).toISOString() });
    expect(scanner.snapshot.rows).toEqual([]);
    await replaySeconds(stream, 65);
    expect(scanner.snapshot.rows).toEqual([]);
    expect(scanner.snapshot.diagnostics.exclusionCounts).toHaveProperty('Known trading halt');
  });
});

describe('observed uptrend candidates', () => {
  const profile = buildVolumeProfile(today, sessions.map(session => ({ session, bars: bars(session), complete: true })));
  const quote = { valid: true, currentSpreadBps: 2, medianSpreadBps: 2, quoteAgeSeconds: 1, validSamples: 60, reasons: [] };
  const evaluate = (patch: Partial<Parameters<typeof evaluateScanner>[0]> = {}) => evaluateScanner({ symbol: 'STEADY', session: today,
    evaluationTime: open + 60 * MINUTE, bars: bars(today, 60), eligible: true, profile, quote, ...patch });

  it('shows actual upward paths with below-threshold participation without admitting them', () => {
    const evaluation = evaluate({ bars: bars(today, 60).map(bar => ({ ...bar, v: 10_000 })) });
    expect(evaluation.qualified).toBe(false);
    expect(evaluation.reasons).toContain('Session RVOL below minimum');
    expect(selectScannerCandidates([evaluation], [], DEFAULT_SCANNER_CONFIG)).toEqual([evaluation]);
    expect(selectScannerCandidates([evaluation], ['STEADY'], DEFAULT_SCANNER_CONFIG)).toEqual([]);
  });

  it('shows pending history and quotes with unknown metrics, and caps candidates', () => {
    const pendingHistory = evaluate({ profile: null });
    expect(pendingHistory.features.sessionRVOL).toBeNull();
    expect(pendingHistory.hardFailure).toBe(true);
    expect(selectScannerCandidates([pendingHistory], [], DEFAULT_SCANNER_CONFIG)).toEqual([pendingHistory]);
    const pendingQuote = evaluate({ quote: null });
    expect(selectScannerCandidates([pendingQuote], [], DEFAULT_SCANNER_CONFIG)).toEqual([pendingQuote]);
    const rows = Array.from({ length: 20 }, (_, i) => ({ ...pendingQuote, symbol: `PICK${i}` }));
    expect(selectScannerCandidates(rows, [], DEFAULT_SCANNER_CONFIG)).toHaveLength(DEFAULT_SCANNER_CONFIG.maxResults);
  });

  it('excludes broken, stale, ineligible, halted, or weak paths even from candidates', () => {
    const broken = bars(today, 60).filter((_, i) => i !== 5);
    const stale = bars(today, 59);
    for (const evaluation of [evaluate({ bars: broken }), evaluate({ bars: stale }), evaluate({ eligible: false }), evaluate({ halted: true }),
      evaluate({ bars: bars(today, 60).map(bar => ({ ...bar, v: 1 })) }),
      evaluate({ profile: { ...profile, averageDailyRthDollarVolume: 10_000 } }),
      evaluate({ bars: bars(today, 60).map(bar => ({ ...bar, o: 100, h: 100, l: 100, c: 100, vw: 100 })) })]) {
      expect(selectScannerCandidates([evaluation], [], DEFAULT_SCANNER_CONFIG)).toEqual([]);
    }
  });
});

describe('base-universe cheap trend features', () => {
  it('evaluates contiguous completed bars only, includes a steady riser, excludes flat and missing paths', () => {
    const current = bars(today, 60);
    expect(cheapTrend(current, today, open + 60 * MINUTE, DEFAULT_SCANNER_CONFIG)).toBeGreaterThan(0);
    expect(cheapTrend(current.filter((_, i) => i !== 40), today, open + 60 * MINUTE, DEFAULT_SCANNER_CONFIG)).toBeNull();
    expect(cheapTrend(current, today, open + 29 * MINUTE, DEFAULT_SCANNER_CONFIG)).toBeNull();
  });
});

describe('scanner 24/5 discovery', () => {
  it('loads sparse BOATS history and admits a Monday 09:00 Berlin candidate after quote warmup', async () => {
    const monday = { date: '2026-09-21', open: Date.parse('2026-09-21T13:30:00Z'), close: Date.parse('2026-09-21T20:00:00Z') };
    const active = sessionSegment(monday, 'overnight');
    vi.useFakeTimers(); vi.setSystemTime(Date.parse('2026-09-21T07:00:06Z'));
    const { scanner, stream, api } = fixture({ calendar: [...sessions, monday], segment: 'overnight', sparse: true }); scanners.push(scanner);
    scanner.start(); await flush();
    expect(scanner.snapshot.diagnostics).toMatchObject({ historyReady: 1, quoteShortlistSize: 1, barsReady: 1 });
    expect(scanner.snapshot.candidates?.[0]?.evaluation.symbol).toBe('STEADY');
    expect(scanner.snapshot.message).not.toContain('gap recovery');
    const initial = api.getBars.mock.calls.filter(([, request]) => request.timeframe === '1Min' && request.start === active.open);
    expect(initial.length).toBe(1);
    await replaySeconds(stream, 124, ['STEADY'], active);
    expect(scanner.snapshot.rows.map(row => row.evaluation.symbol)).toEqual(['STEADY']);
    expect(scanner.snapshot.rows[0].state).toBe('Clean uptrend');
    expect(api.getBars.mock.calls.filter(([, request]) => request.timeframe === '1Min' && request.start === active.open)).toHaveLength(1);
  });

  it('keeps empty overnight data unavailable without labeling the universe as Fading', async () => {
    const active = sessionSegment(today, 'overnight');
    vi.useFakeTimers(); vi.setSystemTime(active.open + 60 * MINUTE + 6000);
    const { scanner, api } = fixture({ segment: 'overnight' }); scanners.push(scanner);
    const getBars = api.getBars.getMockImplementation()!;
    api.getBars.mockImplementation(async (symbols, request) => request.timeframe === '1Min' ? { STEADY: [] } : getBars(symbols, request));
    scanner.start(); await flush();
    expect(scanner.snapshot.rows).toEqual([]);
    expect(scanner.snapshot.candidates).toEqual([]);
    expect(scanner.snapshot.reviewRows?.[0]).toMatchObject({ state: 'Data unavailable', confirmed: false });
    expect(scanner.snapshot.diagnostics.historyReady).toBe(0);
    expect(scanner.snapshot.message).toBe('Waiting for fresh trade bars; no candidates currently qualify.');
  });

  it.each(['overnight', 'premarket', 'afterhours'] as const)('qualifies fresh %s trends using matching historical volume', async segment => {
    const active = sessionSegment(today, segment);
    vi.useFakeTimers(); vi.setSystemTime(active.open + 60 * MINUTE + 6000);
    const { scanner, stream, api } = fixture({ segment }); scanners.push(scanner);
    scanner.start(); await flush(); await replaySeconds(stream, 124, ['STEADY'], active);
    expect(scanner.snapshot.session).toEqual(active);
    expect(scanner.snapshot.rows.map(row => row.evaluation.symbol)).toEqual(['STEADY']);
    const history = api.getBars.mock.calls.filter(([, request]) => request.timeframe === '1Min');
    expect(history.length).toBeGreaterThan(0);
    if (segment === 'overnight') {
      expect(history.some(([, request]) => (request as { feed?: string }).feed === 'boats')).toBe(true);
      expect(history.some(([, request]) => request.start < active.open && !(request as { feed?: string }).feed)).toBe(true);
    }
  });
});
