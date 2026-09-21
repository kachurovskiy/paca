import { fullTradingSession } from '../../core/exchange-session';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ScannerCache } from '../../market/cache';
import { ScannerDataApi } from '../../broker/market-data';
import { type ResearchQuote } from '../../core/market-data';
import { tuneMomentum } from '../math/momentum';
import { UNIVERSE_LIMITS, UniverseService, type UniverseContext, type UniverseResult } from './universe';
import { universeFixture } from './universe-fixtures';

vi.mock('../math/momentum', async importOriginal => ({ ...await importOriginal<typeof import('../math/momentum')>(),
  tuneMomentum: vi.fn(() => { throw new Error('Snapshot loading must not tune parameters'); }),
}));

const services: UniverseService[] = [];
afterEach(() => { services.splice(0).forEach(service => service.dispose()); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const flush = async () => { for (let index = 0; index < 30; index++) await Promise.resolve(); };
function setup(date?: string, close?: string, count?: number, cache = new ScannerCache()) {
  const fixture = universeFixture(date, close, count);
  let now = fixture.now;
  const api = {
    getCalendar: vi.fn(async () => [...fixture.previous, fixture.today]),
    getEligibleAssets: vi.fn(async () => fixture.assets),
    getBars: vi.fn(async (symbols: string[], _options?: unknown, _signal?: AbortSignal) => fixture.daily(symbols)),
    getResearchQuotes: vi.fn(async (symbols: string[], _signal?: AbortSignal) => fixture.quotes(symbols)),
  };
  const service = new UniverseService(api, cache, () => now); services.push(service); service.setContext(fixture.context);
  return { ...fixture, api, service, cache, setNow: (value: number) => { now = value; } };
}
function snapshot(result: UniverseResult) {
  expect(result.status).toBe('available');
  if (result.status !== 'available') throw new Error(JSON.stringify(result));
  return result.snapshot;
}
const code = (result: UniverseResult) => result.status === 'available' ? null : result.blocks[0].code;

describe('neutral as-of research inputs', () => {
  it('retains falling neutral assets, immutable provenance and template eligibility without invoking tuning or evaluation', async () => {
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected network'); }));
    const s = setup();
    const output = snapshot(await s.service.capture('synthetic-input'));
    expect(output.candidates.map(value => value.asset.symbol)).toEqual(['S0002', 'S0001', 'S0000']);
    expect(output.candidates.every(value => value.eligibility.every(result => result.status === 'eligible'))).toBe(true);
    expect(output.liquidity[0]).toMatchObject({ symbol: 'S0000', meanDailyDollars: 10_000, blocks: [], observedDates: s.previous.map(value => value.date) });
    expect(output.horizon).toEqual({ entryWindow: { from: new Date(s.now).toISOString(), to: '2026-09-18T00:00:00.000Z' }, intendedEnd: '2026-09-18T00:00:00.000Z' });
    expect(output.provenance.liquidity).toMatchObject({ feed: 'sip', adjustment: 'split', end: new Date(s.today.open).toISOString() });
    expect(output.dataCutoff).toBe(output.asOf);
    s.assets[0].id = 'changed';
    expect(output.candidates[2].asset.id).toBe('synthetic-listing-0');
    
    
    expect(tuneMomentum).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['2026-03-06', '2026-03-09', '2026-03-23', '2026-10-26', '2026-10-30', '2026-11-02'])(
    'preserves calendar-backed 24/5 instants across US/European DST on %s', async date => {
    const s = setup(date);
    const output = snapshot(await s.service.capture('dst'));
    expect(output.session.openAt).toBe(new Date(fullTradingSession(s.today).open).toISOString());
    expect(output.session.closeAt).toBe(new Date(fullTradingSession(s.today).close).toISOString());
    expect(output.session.timeZone).toBe('America/New_York');
  });

  it('keeps full overnight and extended hours on an exchange half-day', async () => {
    const s = setup('2026-11-27', '13:00');
    const output = snapshot(await s.service.capture('short-session'));
    expect(output.horizon.intendedEnd).toBe('2026-11-28T01:00:00.000Z');
    expect(output.candidates[0].eligibility.map(value => [value.template.id, value.status])).toEqual([['trend-following', 'eligible'], ['wick-capture', 'eligible'], ['vwap-mean-reversion', 'eligible']]);
    expect(output.candidates[0].eligibility[0].blocks).toEqual([]);
  });

  it.each(['2026-11-26', '2026-09-19', '2026-09-20'])('never fabricates a holiday/weekend session for %s', async date => {
    const s = setup(date); s.api.getCalendar.mockResolvedValue(s.previous);
    expect(code(await s.service.capture('closed-date'))).toBe('no_exchange_session');
    expect(s.api.getEligibleAssets).not.toHaveBeenCalled(); expect(s.api.getBars).not.toHaveBeenCalled();
  });

  it.each(['before', 'at-close', 'after'])('researches before and after the regular session: %s', async when => {
    const s = setup(); const now = when === 'before' ? s.today.open - 1 : s.today.close + (when === 'after' ? 1 : 0);
    s.setNow(now); s.service.setContext({ ...s.context, data: { ...s.context.data, asOf: new Date(now).toISOString(), validUntil: new Date(now + 60_000).toISOString() } });
    expect(code(await s.service.capture('extended'))).toBeNull(); expect(s.api.getBars).toHaveBeenCalled();
  });

  it.each([
    ['missing', null], ['stale', { price: 10, tradeAt: '2026-09-17T13:30:29.999Z', bid: 9, ask: 11, quoteAt: '2026-09-17T13:31:00.000Z' }],
    ['future', { price: 10, tradeAt: '2026-09-17T13:31:00.001Z', bid: 9, ask: 11, quoteAt: '2026-09-17T13:31:00.000Z' }],
  ] as const)('retains an explicit %s trade block without replacing it with a candle', async (_label, quote) => {
    const s = setup(); s.api.getResearchQuotes.mockResolvedValue(quote ? Object.fromEntries(s.assets.map(asset => [asset.symbol, quote])) : {});
    const output = snapshot(await s.service.capture('bad-trade'));
    expect(output.candidates.every(value => value.eligibility.every(result => result.blocks.some(block => block.code === 'trade_unavailable')))).toBe(true);
  });

  it.each([
    { bid: null }, { ask: null }, { bid: 11, ask: 10 }, { quoteAt: '2026-09-17T13:30:29.999Z' }, { quoteAt: '2026-09-17T13:31:00.001Z' },
  ])('a fresh trade does not certify missing/stale/crossed bid/ask: %j', async patch => {
    const s = setup(); s.api.getResearchQuotes.mockImplementation(async symbols => Object.fromEntries(symbols.map(symbol => [symbol, { ...s.quotes([symbol])[symbol], ...patch }])));
    const [trend, wick] = snapshot(await s.service.capture('bad-quote')).candidates[0].eligibility;
    expect(trend.status).toBe('eligible'); expect(wick.blocks[0].code).toBe('bid_ask_unavailable');
  });

  it.each([
    ['observed_prices', ['blocked', 'blocked']], ['bid_ask', ['eligible', 'blocked']], ['completed_5min_bars', ['blocked', 'eligible']],
  ] as const)('does not infer the %s data capability', async (capability, statuses) => {
    const s = setup(); s.service.setContext({ ...s.context, data: { ...s.context.data, capabilities: s.context.data.capabilities.filter(value => value !== capability) } });
    expect(snapshot(await s.service.capture('capabilities')).candidates[0].eligibility.map(value => value.status)).toEqual([...statuses, 'blocked']);
  });

  it.each([
    ['disconnected', { status: 'disconnected' }, 'disconnected'], ['missing feed', { feed: null }, 'feed_unavailable'],
    ['unknown entitlement', { status: 'unavailable' }, 'feed_unavailable'],
    ['stale', { asOf: '2026-09-17T13:29:59.999Z' }, 'data_context_stale'],
    ['expired', { validUntil: '2026-09-17T13:31:00.000Z', asOf: '2026-09-17T13:30:00.000Z' }, 'data_context_stale'],
    ['future', { asOf: '2026-09-17T13:31:00.001Z' }, 'data_context_stale'],
  ])('returns structured %s context failure before requests', async (_name, patch, reason) => {
    const s = setup(); s.service.setContext({ ...s.context, data: { ...s.context.data, ...patch } } as UniverseContext);
    expect(code(await s.service.capture('unavailable'))).toBe(reason); expect(s.api.getCalendar).not.toHaveBeenCalled();
  });

  it.each(['getCalendar', 'getEligibleAssets', 'getBars', 'getResearchQuotes'] as const)('does not publish partial input or provider error text when %s fails', async method => {
    const s = setup(); s.api[method].mockRejectedValue(new Error('sensitive-provider-response'));
    const output = await s.service.capture('failed');
    expect(output.status).toBe('unavailable'); expect(JSON.stringify(output)).not.toContain('sensitive-provider');
  });

  it('captures research for a live account without rewriting its scope', async () => {
    const s = setup(), scope = { ...s.context.scope, environment: 'live' as const };
    s.service.setContext({ ...s.context, scope });
    expect(snapshot(await s.service.capture('live-input')).scope).toEqual(scope);
  });

  it('blocks different broker, missing context and obsolete venue dates before I/O', async () => {
    const s = setup();
    s.service.setContext({ ...s.context, scope: { ...s.context.scope, broker: 'unsupported' } });
    expect(code(await s.service.capture('wrong-scope'))).toBe('unsupported_broker');
    s.service.setContext({ ...s.context, tradingDate: '2026-09-16' }); expect(code(await s.service.capture('wrong-date'))).toBe('session_generation_changed');
    s.service.setContext(null); expect(code(await s.service.capture('no-context'))).toBe('context_unavailable');
    expect(s.api.getCalendar).not.toHaveBeenCalled();
  });

  it.each(['missing', 'partial', 'no-vwap', 'zero-volume', 'current-only'])('marks %s liquidity unavailable without assuming zero risk/volume or using today', async kind => {
    const s = setup(); s.api.getBars.mockImplementation(async symbols => Object.fromEntries(symbols.map(symbol => [symbol,
      kind === 'missing' ? [] : kind === 'partial' ? s.daily([symbol])[symbol].slice(1) : s.daily([symbol])[symbol].map(bar =>
        kind === 'no-vwap' ? { ...bar, vw: null } : kind === 'zero-volume' ? { ...bar, v: 0 } : { ...bar, t: new Date(s.today.open).toISOString() }),
    ])));
    const output = snapshot(await s.service.capture('missing-liquidity'));
    expect(output.candidates).toEqual([]); expect(output.liquidity.every(value => value.blocks[0].code === 'liquidity_incomplete')).toBe(true);
    if (kind !== 'partial') expect(output.liquidity.every(value => value.meanDailyDollars === null)).toBe(true);
    expect(s.api.getResearchQuotes).not.toHaveBeenCalled();
  });

  it('requires all previous calendar sessions, rejects malformed/duplicate calendar, and permits an empty tradable universe', async () => {
    for (const calendar of [[], [universeFixture().today], [...universeFixture().previous, universeFixture().today, universeFixture().today]]) {
      const s = setup(); s.api.getCalendar.mockResolvedValue(calendar);
      expect((await s.service.capture('calendar')).status).not.toBe('available'); expect(s.api.getEligibleAssets).not.toHaveBeenCalled();
    }
    const s = setup(undefined, undefined, 0);
    expect(snapshot(await s.service.capture('empty')).breadth.inspectedAssets).toBe(0); expect(s.api.getBars).not.toHaveBeenCalled();
  });

  it('bounds assets, daily batches, pages, candidates and refresh; no timers start further reads', async () => {
    vi.useFakeTimers(); const s = setup(undefined, undefined, 701);
    const output = snapshot(await s.service.capture('bounded'));
    expect(output.breadth).toMatchObject({ availableAssets: 701, inspectedAssets: 600, omittedAssets: 101, liquidAssets: 600, quotedAssets: 30, omittedLiquidAssets: 570 });
    expect(s.api.getBars.mock.calls.map(call => call[0].length)).toEqual([300, 300]);
    expect(s.api.getBars.mock.calls.every(call => (call[1] as { maxPagesPerBatch: number }).maxPagesPerBatch === 2)).toBe(true);
    expect(s.api.getResearchQuotes.mock.calls[0][0]).toHaveLength(30);
    expect(code(await s.service.capture('refresh'))).toBe('refresh_limited');
    await vi.advanceTimersByTimeAsync(120_000); expect(s.api.getCalendar).toHaveBeenCalledTimes(1);
  });

  it('shares account-free liquidity checkpoints with retained as-of evidence but rechecks assets and quotes', async () => {
    const cache = new ScannerCache();
    const first = setup(undefined, undefined, 3, cache); const original = snapshot(await first.service.capture('first'));
    const second = setup(undefined, undefined, 3, cache);
    second.service.setContext({ ...second.context, scope: { ...second.context.scope, accountId: 'second-synthetic-account' } });
    const reused = snapshot(await second.service.capture('second'));
    expect(second.api.getBars).not.toHaveBeenCalled(); expect(second.api.getEligibleAssets).toHaveBeenCalledOnce(); expect(second.api.getResearchQuotes).toHaveBeenCalledOnce();
    expect(reused.liquidity).toEqual(original.liquidity); expect(reused.scope.accountId).toBe('second-synthetic-account');
  });

  it.each(['account', 'session', 'connection', 'entitlement', 'dispose', 'external'])('cancels %s generation immediately and ignores late adapter output', async change => {
    const s = setup(); let finish!: (value: Record<string, ResearchQuote>) => void;
    s.api.getResearchQuotes.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const controller = new AbortController(); const job = s.service.capture('old', controller.signal); await flush();
    expect(s.api.getResearchQuotes).toHaveBeenCalledOnce();
    if (change === 'external') controller.abort();
    else if (change === 'dispose') s.service.dispose();
    else s.service.setContext({ ...s.context,
      ...(change === 'account' ? { scope: { ...s.context.scope, accountId: 'replacement-account' } }
        : change === 'session' ? { tradingDate: '2026-09-18' }
        : change === 'connection' ? { connectionGeneration: 2 }
        : { data: { ...s.context.data, status: 'unavailable' as const } }),
    });
    expect((await job).status).toBe('cancelled');
    expect(s.api.getResearchQuotes.mock.calls[0][1]?.aborted).toBe(true);
    finish(s.quotes(s.assets.map(value => value.symbol))); await flush();
    expect(s.api.getResearchQuotes).toHaveBeenCalledOnce();
  });

  it('aborts pending history without letting a late batch populate the shared cache', async () => {
    const s = setup(); let finish!: (value: ReturnType<typeof s.daily>) => void;
    s.api.getBars.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const job = s.service.capture('late-history'); await flush(); s.service.cancel();
    expect((await job).status).toBe('cancelled'); finish(s.daily(s.assets.map(value => value.symbol))); await flush();
    const next = setup(undefined, undefined, 3, s.cache); await next.service.capture('fresh'); expect(next.api.getBars).toHaveBeenCalledOnce();
    expect(s.api.getResearchQuotes).not.toHaveBeenCalled();
  });

  it('times out an adapter which ignores cancellation, limits overlapping requests and cleans up its timer', async () => {
    vi.useFakeTimers(); const s = setup(); s.api.getCalendar.mockImplementation(() => new Promise(() => {}));
    const job = s.service.capture('timeout'); expect(code(await s.service.capture('busy'))).toBe('research_busy');
    await vi.advanceTimersByTimeAsync(UNIVERSE_LIMITS.durationMs);
    expect(code(await job)).toBe('research_timeout'); expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['backward-clock', 'date-rollover', 'capability-expiry', 'session-close'])('fences %s while requests are pending', async change => {
    const s = setup(); let finish!: (value: Record<string, ResearchQuote>) => void;
    const start = change === 'session-close' ? fullTradingSession(s.today).close - 5000 : s.now;
    s.setNow(start); s.service.setContext({ ...s.context, data: { ...s.context.data, asOf: new Date(start).toISOString(), validUntil: new Date(start + (change === 'capability-expiry' ? 1000 : 60_000)).toISOString() } });
    s.api.getResearchQuotes.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const job = s.service.capture('clock-change'); await flush();
    s.setNow(change === 'backward-clock' ? start - 1 : change === 'date-rollover' ? start + 86_400_000 : start + 5000);
    finish(s.quotes(s.assets.map(value => value.symbol)));
    expect((await job).status).not.toBe('available');
  });

  it.each(['generation', 'feed'])('rejects malformed context %s and cancels the previous job instead of retaining prior account authority', async field => {
    const s = setup(); s.api.getCalendar.mockImplementation(() => new Promise(() => {}));
    const job = s.service.capture('old');
    const context = field === 'generation' ? { ...s.context, connectionGeneration: NaN }
      : { ...s.context, data: { ...s.context.data, feed: 'iex' as UniverseContext['data']['feed'] } };
    expect(() => s.service.setContext(context)).toThrow();
    expect((await job).status).toBe('cancelled'); expect(code(await s.service.capture('new'))).toBe('context_unavailable');
  });

  it('detaches received calendar/assets before subsequent asynchronous requests', async () => {
    const s = setup(); let finish!: (value: Record<string, ResearchQuote>) => void;
    s.api.getResearchQuotes.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const job = s.service.capture('detached'); await flush();
    s.assets[0].id = 'mutated-during-quotes'; s.previous[0].close += 60_000;
    finish(s.quotes(s.assets.map(value => value.symbol)));
    const output = snapshot(await job);
    expect(output.candidates[2].asset.id).toBe('synthetic-listing-0');
    expect(output.previousSessions[0].closeAt).not.toBe(new Date(s.previous[0].close).toISOString());
  });

  it('rechecks quotes on a permitted refresh and does not reuse liquidity for a replacement listing', async () => {
    const s = setup(); await s.service.capture('initial');
    s.setNow(s.now + 30_000); s.assets[0].id = 'replacement-listing';
    const output = snapshot(await s.service.capture('refreshed'));
    expect(s.api.getCalendar).toHaveBeenCalledTimes(2); expect(s.api.getBars).toHaveBeenCalledTimes(2);
    expect(s.api.getResearchQuotes).toHaveBeenCalledTimes(2); expect(output.liquidity[0].listingId).toBe('replacement-listing');
  });

  it('bounds concurrent history work while slower batches remain pending', async () => {
    const s = setup(undefined, undefined, 600);
    const jobs: (() => void)[] = []; let active = 0, maximum = 0;
    s.api.getBars.mockImplementation(symbols => new Promise(resolve => {
      active++; maximum = Math.max(maximum, active);
      jobs.push(() => { active--; resolve(s.daily(symbols)); });
    }));
    const job = s.service.capture('concurrency'); await flush();
    expect(jobs).toHaveLength(2); jobs[0](); await flush(); expect(s.api.getResearchQuotes).not.toHaveBeenCalled();
    jobs[1](); snapshot(await job); expect(maximum).toBe(2);
  });

  it('binds replacement account adapters atomically and never mixes an old job with the new transport', async () => {
    const s = setup(), replacement = setup();
    s.api.getCalendar.mockImplementation(() => new Promise(() => {}));
    const oldJob = s.service.capture('old-transport'); await flush();
    s.service.setContext({ ...s.context, scope: { ...s.context.scope, accountId: 'replacement-account' }, connectionGeneration: 2 }, replacement.api);
    expect((await oldJob).status).toBe('cancelled');
    s.setNow(s.now + 30_000);
    const result = snapshot(await s.service.capture('new-transport'));
    expect(result.scope.accountId).toBe('replacement-account'); expect(result.connectionGeneration).toBe(2);
    expect(replacement.api.getCalendar).toHaveBeenCalledOnce(); expect(s.api.getEligibleAssets).not.toHaveBeenCalled();
  });
});

describe('existing read-only data adapter bounds', () => {
  it('bounds actual history pagination and refuses partial results', async () => {
    const fixture = universeFixture(); let calls = 0;
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ bars: {}, next_page_token: `page-${++calls}` })));
    const api = new ScannerDataApi({ keyId: 'synthetic-key', secretKey: 'synthetic-secret', environment: 'paper' }, { fetch: fetcher, minRequestIntervalMs: 0, maxRetries: 0, now: () => Date.parse('2026-09-17T14:00:00Z') });
    try {
      await expect(api.getBars(['S0000'], { start: fixture.previous[0].open, end: fixture.today.open, timeframe: '1Day', maxPagesPerBatch: 2 })).rejects.toThrow('page cap');
      expect(fetcher).toHaveBeenCalledTimes(2);
    } finally { api.dispose(); }
  });

  it('reuses the existing shared snapshot request and keeps missing observations unavailable with separate timestamps', async () => {
    let finish!: (response: Response) => void;
    const fetcher = vi.fn(() => new Promise<Response>(resolve => { finish = resolve; }));
    const api = new ScannerDataApi({ keyId: 'synthetic-key', secretKey: 'synthetic-secret', environment: 'paper' }, { fetch: fetcher, minRequestIntervalMs: 0, maxRetries: 0, now: () => Date.parse('2026-09-17T14:00:00Z') });
    try {
      const scanner = api.getSnapshots(['S0000', 'S0001']); const research = api.getResearchQuotes(['S0001', 'S0000']); await flush();
      finish(new Response(JSON.stringify({ S0000: { latestTrade: { p: 10, t: '2026-09-17T13:31:00Z' }, latestQuote: { bp: 9, ap: 11, t: '2026-09-17T13:30:00Z' }, prevDailyBar: { c: 12 } } })));
      expect((await scanner).S0000.previousClose).toBe(12);
      expect((await research).S0000).toMatchObject({ tradeAt: '2026-09-17T13:31:00.000Z', quoteAt: '2026-09-17T13:30:00.000Z' });
      expect((await research).S0001).toEqual({ price: null, tradeAt: null, bid: null, ask: null, quoteAt: null });
      expect(fetcher).toHaveBeenCalledOnce();
    } finally { api.dispose(); }
  });
});

describe('overnight research calendar and universe', () => {
  it('uses Monday calendar evidence on Sunday night and excludes ineligible overnight stocks', async () => {
    const s = setup('2026-09-21'), now = Date.parse('2026-09-21T02:00:00Z');
    s.assets[0].overnightTradable = true; s.setNow(now);
    const at = new Date(now).toISOString();
    s.service.setContext({ ...s.context, data: { ...s.context.data, feed: 'boats', asOf: at, validUntil: new Date(now + 60_000).toISOString() } });
    s.api.getResearchQuotes.mockImplementation(async symbols => Object.fromEntries(symbols.map(symbol => [symbol, { price: 10, bid: 9.99, ask: 10.01, tradeAt: at, quoteAt: at }])));
    const output = snapshot(await s.service.capture('sunday-night'));
    expect(output.session).toMatchObject({ tradingDate: '2026-09-21', openAt: '2026-09-21T00:00:00.000Z', closeAt: '2026-09-22T00:00:00.000Z' });
    expect(output.candidates.map(candidate => candidate.asset.symbol)).toEqual(['S0000']);
    expect(output.candidates[0].eligibility.every(row => row.status === 'eligible')).toBe(true);
    expect(output.provenance.quotes.feed).toBe('boats');
  });
  it('keeps a holiday eve closed despite BOATS entitlement', async () => {
    const s = setup('2026-11-26'), now = Date.parse('2026-11-26T03:00:00Z'); s.setNow(now);
    s.service.setContext({ ...s.context, data: { ...s.context.data, feed: 'boats', asOf: new Date(now).toISOString(), validUntil: new Date(now + 60_000).toISOString() } });
    s.api.getCalendar.mockResolvedValue(s.previous);
    expect(code(await s.service.capture('holiday-eve'))).toBe('no_exchange_session');
    expect(s.api.getResearchQuotes).not.toHaveBeenCalled();
  });
});
