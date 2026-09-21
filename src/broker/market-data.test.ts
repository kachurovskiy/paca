import { afterEach, describe, expect, it, vi } from 'vitest';
import { ScannerDataApi, calendarTimeToUtc, type ScannerDataOptions } from './market-data';
import type { Credentials } from '../core/types';

const credentials: Credentials = { keyId: 'scanner-test-key', secretKey: 'scanner-test-secret', environment: 'paper' };
const session = { date: '2026-09-17', open: Date.parse('2026-09-17T13:30:00Z'), close: Date.parse('2026-09-17T20:00:00Z') };
const bar = (minute = 0, overrides = {}) => ({ t: new Date(session.open + minute * 60_000).toISOString(), o: 100, h: 101, l: 99, c: 100.5, v: 1000, vw: 100.25, ...overrides });
const response = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const options = { start: session.open, end: session.open + 120_000, timeframe: '1Min' as const };
const flush = async () => { for (let index = 0; index < 8; index++) await Promise.resolve(); };
const instances: ScannerDataApi[] = [];
const make = (fetcher: ReturnType<typeof vi.fn>, options: ScannerDataOptions = {}) => {
  const api = new ScannerDataApi(credentials, { fetch: fetcher as typeof fetch, minRequestIntervalMs: 0, maxRetries: 0, ...options });
  instances.push(api); return api;
};
afterEach(() => { instances.splice(0).forEach(api => api.dispose()); vi.useRealTimers(); });

describe('ScannerDataApi read-only Alpaca contract', () => {
  it('loads bounded five-minute research history through GET-only SIP pages', async () => {
    const fetcher = vi.fn().mockResolvedValue(response({ bars: { SPY: [bar(), bar(5)] }, next_page_token: null }));
    const result = await make(fetcher).getBars(['SPY'], { ...options, end: session.open + 600_000, timeframe: '5Min', maxPagesPerBatch: 2, maxBarsPerSymbol: 2 });
    expect(result.SPY).toHaveLength(2);
    expect(new URL(fetcher.mock.calls[0][0]).searchParams.get('timeframe')).toBe('5Min');
    expect(fetcher.mock.calls[0][1].method).toBe('GET');
  });

  it('rejects misaligned five-minute bars and row-cap overflow without returning truncated history', async () => {
    const request = { ...options, end: session.open + 600_000, timeframe: '5Min' as const, maxBarsPerSymbol: 1 };
    const misaligned = vi.fn().mockResolvedValue(response({ bars: { SPY: [bar(1)] }, next_page_token: null }));
    await expect(make(misaligned).getBars(['SPY'], request)).rejects.toThrow('interval');
    const overflow = vi.fn().mockResolvedValue(response({ bars: { SPY: [bar(), bar(5)] }, next_page_token: null }));
    await expect(make(overflow).getBars(['SPY'], request)).rejects.toThrow('row cap');
    const noReads = vi.fn();
    await expect(make(noReads).getBars(['SPY'], { ...request, maxBarsPerSymbol: 0 })).rejects.toThrow('row cap');
    expect(noReads).not.toHaveBeenCalled();
  });

  it('exposes unavailable optional halt capability honestly', () => {
    expect(make(vi.fn()).optionalStatusCapability).toBe('unsupported');
  });

  it('uses New York DST independently from Europe and preserves holidays and early close times', async () => {
    expect(new Date(calendarTimeToUtc('2026-03-06', '09:30')).toISOString()).toBe('2026-03-06T14:30:00.000Z');
    expect(new Date(calendarTimeToUtc('2026-03-09', '09:30')).toISOString()).toBe('2026-03-09T13:30:00.000Z');
    expect(new Date(calendarTimeToUtc('2026-03-23', '16:00')).toISOString()).toBe('2026-03-23T20:00:00.000Z');
    const fetcher = vi.fn().mockResolvedValue(response([{ date: '2026-11-27', open: '09:30', close: '13:00' }]));
    const api = make(fetcher);
    expect(await api.getCalendar('2026-11-26', '2026-11-27')).toEqual([{ date: '2026-11-27', open: Date.parse('2026-11-27T14:30:00Z'), close: Date.parse('2026-11-27T18:00:00Z') }]);
    expect(fetcher.mock.calls[0][0]).toContain('https://paper-api.alpaca.markets/v2/calendar?');
    expect(() => calendarTimeToUtc('2026-02-30', '09:30')).toThrow('invalid');
  });

  it('filters only by reliable eligibility metadata and preserves eligible ETFs and symbol suffixes', async () => {
    const asset = { id: 'id', class: 'us_equity', status: 'active', tradable: true, exchange: 'NASDAQ', name: 'An asset' };
    const fetcher = vi.fn().mockResolvedValue(response([
      { ...asset, symbol: 'AAPL' }, { ...asset, symbol: 'SPY', exchange: 'ARCA' }, { ...asset, symbol: 'ABC.W' },
      { ...asset, symbol: 'OTCX', exchange: 'OTC' }, { ...asset, symbol: 'INACTIVE', status: 'inactive' },
      { ...asset, symbol: 'NOPE', tradable: false }, { ...asset, symbol: 'BTC', class: 'crypto' },
      { ...asset, symbol: 'UNKNOWN', exchange: '' }, { ...asset, symbol: 'AAPL' },
    ]));
    expect((await make(fetcher).getEligibleAssets()).map(asset => asset.symbol)).toEqual(['AAPL', 'ABC.W', 'SPY']);
    expect(fetcher.mock.calls[0][1].method).toBe('GET');
  });

  it('exhausts total-limit pages across symbols and replaces duplicate timestamp bars without double volume', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ bars: { AAPL: [bar()] }, next_page_token: 'next' }))
      .mockResolvedValueOnce(response({ bars: { AAPL: [bar(0, { v: 1100 }), bar(1)], MSFT: [bar(0, { vw: undefined })] }, next_page_token: null }));
    const result = await make(fetcher).getBars(['MSFT', 'AAPL', 'AAPL'], options);
    expect(result.AAPL.map(value => value.v)).toEqual([1100, 1000]);
    expect(result.MSFT[0].vw).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(2);
    for (const [url, init] of fetcher.mock.calls) {
      const parsed = new URL(url);
      expect(parsed.origin).toBe('https://data.alpaca.markets');
      expect(parsed.searchParams.get('feed')).toBe('sip');
      expect(parsed.searchParams.get('adjustment')).toBe('split');
      expect(parsed.searchParams.get('limit')).toBe('10000');
      expect(parsed.searchParams.get('end')).toBe(new Date(options.end - 1).toISOString());
      expect(init.method).toBe('GET');
      expect(url).not.toContain(credentials.keyId); expect(url).not.toContain(credentials.secretKey);
    }
    expect(new URL(fetcher.mock.calls[1][0]).searchParams.get('page_token')).toBe('next');
  });

  it('uses larger URL-bounded daily batches without changing minute batches or dropping later pages', async () => {
    const symbols = Array.from({ length: 301 }, (_, index) => `S${String(index).padStart(14, '0')}`);
    const fetcher = vi.fn(async (url: string) => {
      const params = new URL(url).searchParams, group = params.get('symbols')!.split(',');
      const firstDailyPage = params.get('timeframe') === '1Day' && group.length === 300 && !params.has('page_token');
      const included = firstDailyPage ? group.slice(0, 1) : params.has('page_token') ? group.slice(1) : group;
      return response({ bars: Object.fromEntries(included.map(symbol => [symbol, [bar()]])), next_page_token: firstDailyPage ? 'remaining-symbols' : null });
    });
    const api = make(fetcher);
    const daily = await api.getBars(symbols, { ...options, timeframe: '1Day' });
    expect(Object.values(daily).every(bars => bars.length === 1)).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls.map(([url]) => new URL(url).searchParams.get('symbols')!.split(',').length).sort((a, b) => a - b)).toEqual([1, 300, 300]);
    expect(fetcher.mock.calls.every(([url]) => url.length < 8000)).toBe(true);
    fetcher.mockClear();
    await api.getBars(symbols, options);
    expect(fetcher.mock.calls.map(([url]) => new URL(url).searchParams.get('symbols')!.split(',').length).sort((a, b) => a - b)).toEqual([1, 100, 100, 100]);
  });

  it.each([
    { bars: { AAPL: [bar()] } },
    { bars: { AAPL: [bar(0, { c: null })] }, next_page_token: null },
    { bars: { AAPL: [bar(0, { t: '2026-09-17T13:30:30Z' })] }, next_page_token: null },
    { bars: { AAPL: [bar(5)] }, next_page_token: null },
    { next_page_token: null },
  ])('rejects incomplete or invalid data rather than returning manufactured coverage', async body => {
    await expect(make(vi.fn().mockResolvedValue(response(body))).getBars(['AAPL'], options)).rejects.toThrow();
  });

  it('rejects repeated tokens and failed later pages; a retry starts a complete request', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ bars: { AAPL: [bar()] }, next_page_token: 'repeat' }))
      .mockResolvedValueOnce(response({ bars: {}, next_page_token: 'repeat' }))
      .mockResolvedValueOnce(response({ bars: { AAPL: [bar()] }, next_page_token: 'second' }))
      .mockResolvedValueOnce(response({ message: credentials.secretKey }, 500))
      .mockResolvedValueOnce(response({ bars: { AAPL: [bar(), bar(1)] }, next_page_token: null }));
    const api = make(fetcher);
    await expect(api.getBars(['AAPL'], options)).rejects.toThrow('repeated');
    await expect(api.getBars(['AAPL'], options)).rejects.toThrow('temporarily unavailable');
    expect((await api.getBars(['AAPL'], options)).AAPL).toHaveLength(2);
    expect(new URL(fetcher.mock.calls[4][0]).searchParams.has('page_token')).toBe(false);
  });

  it('deduplicates simultaneous requests while one cancelled consumer cannot abort another', async () => {
    let resolveFetch!: (value: Response) => void;
    const fetcher = vi.fn().mockImplementation(() => new Promise<Response>(resolve => { resolveFetch = resolve; }));
    const api = make(fetcher);
    const controller = new AbortController();
    const first = api.getBars(['AAPL'], options, controller.signal);
    const second = api.getBars(['AAPL'], options);
    const cancelled = expect(first).rejects.toMatchObject({ name: 'AbortError' });
    await flush();
    controller.abort();
    await cancelled;
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][1].signal.aborted).toBe(false);
    resolveFetch(response({ bars: { AAPL: [bar()] }, next_page_token: null }));
    expect((await second).AAPL).toHaveLength(1);
  });

  it('bounds active requests and disposal cancels queued and in-flight work', async () => {
    const fetcher = vi.fn().mockImplementation((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    }));
    const api = make(fetcher, { maxConcurrency: 2 });
    const jobs = ['AAPL', 'MSFT', 'SPY', 'QQQ'].map(symbol => api.getSnapshots([symbol]));
    const results = Promise.allSettled(jobs);
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(2);
    api.dispose();
    expect((await results).every(result => result.status === 'rejected' && result.reason.name === 'AbortError')).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
    await expect(api.getSnapshots(['AAPL'])).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('honors Retry-After before retrying 429 responses without falling back to another feed', async () => {
    vi.useFakeTimers(); vi.setSystemTime(session.open);
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({}, 429, { 'Retry-After': '3' }))
      .mockResolvedValueOnce(response({ AAPL: { prevDailyBar: { c: 99 } } }));
    const pending = make(fetcher, { maxRetries: 1 }).getSnapshots(['AAPL']);
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2999);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual({ AAPL: { previousClose: 99 } });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.every(([url]) => new URL(url).searchParams.get('feed') === 'sip')).toBe(true);
  });

  it('throttles the shared request budget across different endpoints', async () => {
    vi.useFakeTimers(); vi.setSystemTime(session.open);
    const fetcher = vi.fn().mockImplementation(() => Promise.resolve(response({})));
    const api = make(fetcher, { minRequestIntervalMs: 350 });
    const first = api.getSnapshots(['AAPL']), second = api.getSnapshots(['MSFT']);
    await flush(); expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(349); expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); await Promise.all([first, second]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('keeps error text credential-free and never silently retries entitlement failures', async () => {
    const fetcher = vi.fn().mockResolvedValue(response({ message: credentials.secretKey }, 403));
    await expect(make(fetcher).getSnapshots(['AAPL'])).rejects.toThrow('feed subscription');
    expect(fetcher).toHaveBeenCalledTimes(1);
    const malicious = vi.fn().mockRejectedValue(new Error(`Scanner ${credentials.keyId} ${credentials.secretKey}`));
    const error = await make(malicious).getSnapshots(['AAPL']).catch(error => error as Error);
    expect(error.message).not.toContain(credentials.keyId); expect(error.message).not.toContain(credentials.secretKey);
  });

  it('uses fresh session-specific discovery hints, deduplicates them, and retains partial-source warnings', async () => {
    const now = session.open + 60 * 60_000;
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ last_updated: new Date(now - 60_000).toISOString(), most_actives: [{ symbol: 'AAPL' }, { symbol: 'AAPL' }, { symbol: 'SPY' }] }))
      .mockResolvedValueOnce(response({ last_updated: '2026-09-16T19:00:00Z', gainers: [{ symbol: 'OLD' }] }));
    expect(await make(fetcher).getDiscovery(session, now)).toEqual({ symbols: ['AAPL', 'SPY'], warnings: [expect.stringContaining('another session')], updatedAt: now - 60_000, mostActiveCount: 2, moversCount: 0 });
    expect(fetcher.mock.calls[0][0]).toContain('by=volume&top=100');
    expect(fetcher.mock.calls[1][0]).toContain('/stocks/movers?top=50');
  });

  it('does not fetch discovery outside the actual exchange session or accept future hints', async () => {
    const fetcher = vi.fn().mockResolvedValue(response({ last_updated: new Date(session.open + 60_000).toISOString(), most_actives: [{ symbol: 'AAPL' }], gainers: [{ symbol: 'AAPL' }] }));
    const api = make(fetcher);
    expect((await api.getDiscovery(session, session.close)).symbols).toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
    expect((await api.getDiscovery(session, session.open)).symbols).toEqual([]);
  });

  it('loads the authoritative prior daily close without inventing missing snapshot values', async () => {
    const fetcher = vi.fn().mockResolvedValue(response({ AAPL: { prevDailyBar: { c: 99 }, dailyBar: { c: 120 } }, MSFT: { dailyBar: { c: 200 } } }));
    expect(await make(fetcher).getSnapshots(['AAPL', 'MSFT', 'SPY'])).toEqual({ AAPL: { previousClose: 99 }, MSFT: { previousClose: null }, SPY: { previousClose: null } });
  });

  it('follows corporate-action pagination and fingerprints corrected split terms deterministically', async () => {
    const split = { id: 'split-1', symbol: 'AAPL', new_rate: 4, old_rate: 1, process_date: '2026-09-17', ex_date: '2026-09-17', cusip: 'example' };
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ corporate_actions: { forward_splits: [split] }, next_page_token: 'ca-next' }))
      .mockResolvedValueOnce(response({ corporate_actions: { forward_splits: [split] }, next_page_token: null }))
      .mockResolvedValueOnce(response({ corporate_actions: { forward_splits: [{ ...split, new_rate: 5 }] }, next_page_token: null }));
    const api = make(fetcher);
    const first = await api.getSplitFingerprint(['AAPL', 'MSFT'], '2026-07-01', session.date);
    expect(first.MSFT).toBe('none');
    expect(first.AAPL.match(/split-1/g)).toHaveLength(1);
    const corrected = await api.getSplitFingerprint(['AAPL', 'MSFT'], '2026-07-01', session.date);
    expect(corrected.AAPL).not.toBe(first.AAPL);
    expect(new URL(fetcher.mock.calls[0][0]).pathname).toBe('/v1/corporate-actions');
    expect(new URL(fetcher.mock.calls[1][0]).searchParams.get('page_token')).toBe('ca-next');
  });

  it('marks unit splits unsupported rather than assuming forward-split adjustment semantics', async () => {
    const fetcher = vi.fn().mockResolvedValue(response({ corporate_actions: { unit_splits: [{ old_symbol: 'OLD', new_symbol: 'NEW', alternate_symbol: 'ALT', old_rate: 1, new_rate: 1, alternate_rate: 1, process_date: session.date, effective_date: session.date }] }, next_page_token: null }));
    const fingerprints = await make(fetcher).getSplitFingerprint(['OLD', 'NEW', 'ALT', 'SPY'], '2026-07-01', session.date);
    expect(fingerprints.OLD).toMatch(/^unsupported-unit-split:/);
    expect(fingerprints.NEW).toMatch(/^unsupported-unit-split:/);
    expect(fingerprints.SPY).toBe('none');
  });
});

describe('24/5 research data routing', () => {
  it('reads BOATS quotes overnight and retains explicit asset eligibility', async () => {
    const fetcher = vi.fn(async (url: string) => response(url.includes('/assets')
      ? [{ id: 'spy', symbol: 'SPY', name: 'SPY', class: 'us_equity', status: 'active', tradable: true, exchange: 'ARCA', attributes: ['overnight_tradable'] }]
      : { SPY: { latestTrade: { p: 100, t: '2026-09-21T02:00:00Z' }, latestQuote: { bp: 99, ap: 101, t: '2026-09-21T02:00:00Z' } } }));
    const api = make(fetcher, { now: () => Date.parse('2026-09-21T02:00:00Z') });
    expect((await api.getEligibleAssets())[0].overnightTradable).toBe(true);
    expect((await api.getResearchQuotes(['SPY'])).SPY.price).toBe(100);
    expect(new URL(fetcher.mock.calls[1][0]).searchParams.get('feed')).toBe('boats');
  });
  it('merges SIP and BOATS history by actual session time and rejects a combined row overflow', async () => {
    const overnight = bar(0, { t: '2026-09-21T07:55:00.000Z' }), daytime = bar(0, { t: '2026-09-21T08:00:00.000Z' });
    const fetcher = vi.fn(async () => response({ bars: { SPY: [overnight, daytime] }, next_page_token: null }));
    const api = make(fetcher), request = { timeframe: '5Min' as const, start: Date.parse(overnight.t), end: Date.parse(daytime.t) + 300_000, includeOvernight: true };
    expect((await api.getBars(['SPY'], request)).SPY.map(bar => bar.t)).toEqual([overnight.t, daytime.t]);
    expect(fetcher.mock.calls).toHaveLength(2);
    await expect(api.getBars(['SPY'], { ...request, maxBarsPerSymbol: 1 })).rejects.toThrow('row cap');
  });
});
