import { calendarTimeToUtc } from '../core/exchange-session';
export { calendarTimeToUtc } from '../core/exchange-session';
import { isOvernightTime } from '../core/trading-session';
import type { ResearchQuote, ScannerAsset, ScannerBarsRequest, ScannerDiscovery, ScannerSnapshot } from '../core/market-data';
import type { Credentials } from '../core/types';
import type { ScannerBar, ScannerSession } from '../scanner/types';
import { BrokerTransport } from './http';
import type { ApiActivity } from '../core/api-activity';
export interface ScannerDataOptions { fetch?: typeof fetch; maxConcurrency?: number; minRequestIntervalMs?: number; maxRetries?: number; now?: () => number; activity?: ApiActivity }
type Json = Record<string, unknown>;
type Pending = { controller: AbortController; promise: Promise<unknown>; consumers: number };
const DATA_HOST = 'https://data.alpaca.markets';
const BATCH_SIZE = 100;
// Stock bars have no documented 100-symbol cap (unlike options). 300 daily
// symbols usually fit 20 sessions in one 10,000-row page and keep URLs bounded.
// https://docs.alpaca.markets/us/reference/stockbars
export const SCANNER_DAILY_BATCH_SIZE = 300;
const SYMBOL = /^[A-Z][A-Z0-9.-]{0,14}$/;
const record = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value);
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;
const nonnegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const timestamp = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
const abortError = () => new DOMException('Scanner request cancelled.', 'AbortError');
const dateValid = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;

function normalizeSymbols(values: string[]): string[] {
  const result = [...new Set(values.map(value => value.trim().toUpperCase()))].sort();
  if (result.some(value => !SYMBOL.test(value))) throw new Error('Scanner received an invalid US equity symbol.');
  return result;
}


function mapBar(value: unknown): ScannerBar {
  if (!record(value) || !timestamp(value.t) || !positive(value.o) || !positive(value.h) || !positive(value.l) || !positive(value.c) || !nonnegative(value.v)) throw new Error('Scanner history contains an incomplete candle; the request is not usable.');
  const { o, h, l, c, v } = value;
  if (h < Math.max(o, l, c) || l > Math.min(o, h, c)) throw new Error('Scanner history contains an invalid candle range.');
  return { t: new Date(value.t).toISOString(), o, h, l, c, v, vw: positive(value.vw) ? value.vw : null };
}

function nextToken(page: Json, seen: Set<string>): string | null {
  const token = page.next_page_token;
  if (token === null) return null;
  if (typeof token !== 'string' || !token || seen.has(token)) throw new Error('Alpaca returned missing or repeated scanner pagination; history is incomplete.');
  seen.add(token);
  return token;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (record(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

/** Read-only REST surface: no order-changing paths or HTTP methods are exposed here. */
export class ScannerDataApi {
  readonly optionalStatusCapability = 'unsupported' as const;
  private readonly transport: BrokerTransport;
  private readonly tradingHost: string;
  private readonly now: () => number;
  private readonly concurrency: number;
  private readonly interval: number;
  private readonly retries: number;
  private readonly pending = new Map<string, Pending>();
  private readonly queue: { run: () => void; cancel: () => void }[] = [];
  private active = 0;
  private nextStart = 0;
  private disposed = false;

  constructor(credentials: Credentials, options: ScannerDataOptions = {}) {
    if (!credentials.keyId.trim() || !credentials.secretKey.trim() || /[\r\n]/.test(credentials.keyId + credentials.secretKey)) throw new Error('Valid Alpaca credentials are required for the scanner.');
    if (!['paper', 'live'].includes(credentials.environment)) throw new Error('Choose a paper or live account.');
    this.transport = new BrokerTransport(credentials, options.fetch, options.activity);
    this.tradingHost = credentials.environment === 'live' ? 'https://api.alpaca.markets' : 'https://paper-api.alpaca.markets';
    this.now = options.now ?? Date.now;
    this.concurrency = options.maxConcurrency ?? 3;
    this.interval = options.minRequestIntervalMs ?? 350;
    this.retries = options.maxRetries ?? 3;
    if (!Number.isInteger(this.concurrency) || this.concurrency < 1 || this.concurrency > 8 || !Number.isFinite(this.interval) || this.interval < 0 || !Number.isInteger(this.retries) || this.retries < 0 || this.retries > 5) throw new Error('Invalid scanner request limits.');
  }

  dispose(): void {
    this.disposed = true;
    for (const item of this.pending.values()) item.controller.abort();
    this.pending.clear();
    this.transport.dispose();
  }

  async getCalendar(startDate: string, endDate: string, signal?: AbortSignal): Promise<ScannerSession[]> {
    this.validateDates(startDate, endDate);
    const body = await this.request(this.tradingHost, `/v2/calendar?${new URLSearchParams({ start: startDate, end: endDate })}`, signal);
    if (!Array.isArray(body)) throw new Error('Alpaca returned an incomplete exchange calendar.');
    const sessions = new Map<string, ScannerSession>();
    for (const value of body) {
      if (!record(value) || !dateValid(value.date) || typeof value.open !== 'string' || typeof value.close !== 'string') throw new Error('Alpaca returned an invalid exchange session.');
      const open = calendarTimeToUtc(value.date, value.open), close = calendarTimeToUtc(value.date, value.close);
      if (close <= open || value.date < startDate || value.date > endDate) throw new Error('Alpaca returned an invalid exchange session boundary.');
      sessions.set(value.date, { date: value.date, open, close });
    }
    return [...sessions.values()].sort((a, b) => a.open - b.open);
  }

  async getEligibleAssets(signal?: AbortSignal): Promise<ScannerAsset[]> {
    const body = await this.request(this.tradingHost, '/v2/assets?status=active&asset_class=us_equity', signal);
    if (!Array.isArray(body)) throw new Error('Alpaca returned an incomplete asset universe.');
    const eligible = new Map<string, ScannerAsset>();
    for (const asset of body) {
      if (!record(asset) || asset.class !== 'us_equity' || asset.status !== 'active' || asset.tradable !== true || typeof asset.exchange !== 'string' || !asset.exchange || asset.exchange === 'OTC' || typeof asset.symbol !== 'string' || !SYMBOL.test(asset.symbol)) continue;
      if (typeof asset.id !== 'string' || !asset.id) continue;
      const attributes = Array.isArray(asset.attributes) ? asset.attributes : [];
      eligible.set(asset.symbol, { symbol: asset.symbol, id: asset.id, name: typeof asset.name === 'string' ? asset.name : asset.symbol, exchange: asset.exchange,
        overnightTradable: (asset.overnight_tradable === true || attributes.includes('overnight_tradable'))
          && asset.overnight_halted !== true && !attributes.includes('overnight_halted') });
    }
    return [...eligible.values()].sort((a, b) => a.symbol.localeCompare(b.symbol));
  }

  /** Half-open UTC interval [start,end). API limit is total per page, never per symbol. */
  async getBars(values: string[], options: ScannerBarsRequest, signal?: AbortSignal): Promise<Record<string, ScannerBar[]>> {
    if (!Number.isFinite(options.start) || !Number.isFinite(options.end) || options.end <= options.start || !['1Min', '5Min', '1Day'].includes(options.timeframe)) throw new Error('Invalid scanner history interval.');
    if (options.maxPagesPerBatch !== undefined && (!Number.isSafeInteger(options.maxPagesPerBatch) || options.maxPagesPerBatch < 1 || options.maxPagesPerBatch > 100)) throw new Error('Invalid scanner history page cap.');
    if (options.maxBarsPerSymbol !== undefined && (!Number.isSafeInteger(options.maxBarsPerSymbol) || options.maxBarsPerSymbol < 1 || options.maxBarsPerSymbol > 10000)) throw new Error('Invalid scanner history row cap.');
    if (options.includeOvernight && options.timeframe !== '1Day') {
      const feeds = await Promise.all(['sip', 'boats'].map(feed => this.getBars(values, { ...options, includeOvernight: false, feed: feed as 'sip' | 'boats' }, signal)));
      return Object.fromEntries(normalizeSymbols(values).map(symbol => {
        const bars = feeds.flatMap((rows, index) => (rows[symbol] ?? []).filter(bar => isOvernightTime(Date.parse(bar.t)) === (index === 1)))
          .sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
        if (options.maxBarsPerSymbol !== undefined && bars.length > options.maxBarsPerSymbol) throw new Error('Combined history row cap reached; history is incomplete.');
        return [symbol, bars];
      }));
    }
    const symbols = normalizeSymbols(values);
    const result: Record<string, ScannerBar[]> = Object.fromEntries(symbols.map(symbol => [symbol, []]));
    await this.batches(symbols, async batch => {
      const bars = new Map(batch.map(symbol => [symbol, new Map<number, ScannerBar>()]));
      const params = new URLSearchParams({ symbols: batch.join(','), timeframe: options.timeframe, start: new Date(options.start).toISOString(), end: new Date(options.end - 1).toISOString(), feed: options.feed ?? 'sip', adjustment: 'split', sort: 'asc', limit: '10000' });
      const seen = new Set<string>();
      let pages = 0;
      let token: string | null;
      do {
        if (options.maxPagesPerBatch !== undefined && pages++ >= options.maxPagesPerBatch) throw new Error('Scanner history page cap reached; history is incomplete.');
        const page = await this.request(DATA_HOST, `/v2/stocks/bars?${params}`, signal);
        if (!record(page) || !Object.hasOwn(page, 'bars') || (page.bars !== null && !record(page.bars))) throw new Error('Alpaca returned incomplete scanner history.');
        for (const [symbol, values] of Object.entries(page.bars ?? {})) {
          if (!bars.has(symbol) || !Array.isArray(values)) throw new Error('Alpaca returned invalid scanner history symbols.');
          for (const value of values) {
            const bar = mapBar(value), time = Date.parse(bar.t);
            const interval = options.timeframe === '1Day' ? 1 : options.timeframe === '5Min' ? 300_000 : 60_000;
            if (time < options.start || time >= options.end || time % interval !== 0) throw new Error('Alpaca returned a candle outside the requested scanner interval.');
            bars.get(symbol)!.set(time, bar); // Revised/duplicate rows replace; volumes never accumulate twice.
            if (options.maxBarsPerSymbol !== undefined && bars.get(symbol)!.size > options.maxBarsPerSymbol) throw new Error('Scanner history row cap reached; history is incomplete.');
          }
        }
        token = nextToken(page, seen);
        if (token) params.set('page_token', token);
      } while (token);
      for (const [symbol, rows] of bars) result[symbol] = [...rows.values()].sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
    }, options.timeframe === '1Day' ? SCANNER_DAILY_BATCH_SIZE : BATCH_SIZE);
    return result;
  }

  async getDiscovery(session: ScannerSession, now: number, signal?: AbortSignal): Promise<ScannerDiscovery> {
    const result: ScannerDiscovery = { symbols: [], warnings: [], updatedAt: null, mostActiveCount: 0, moversCount: 0 };
    if (now < session.open || now >= session.close) return result;
    const feeds = [
      { path: '/v1beta1/screener/stocks/most-actives?by=volume&top=100', field: 'most_actives', label: 'Most-active', count: 'mostActiveCount' as const, limit: 100 },
      { path: '/v1beta1/screener/stocks/movers?top=50', field: 'gainers', label: 'Movers', count: 'moversCount' as const, limit: 50 },
    ];
    const responses = await Promise.allSettled(feeds.map(feed => this.request(DATA_HOST, feed.path, signal)));
    if (signal?.aborted || this.disposed) throw abortError();
    responses.forEach((response, index) => {
      const feed = feeds[index];
      if (response.status === 'rejected') { result.warnings.push(`${feed.label} discovery unavailable: ${response.reason instanceof Error ? response.reason.message : 'request failed'}`); return; }
      const body = response.value;
      if (!record(body) || !timestamp(body.last_updated) || !Array.isArray(body[feed.field])) { result.warnings.push(`${feed.label} discovery has incomplete data.`); return; }
      const updated = Date.parse(body.last_updated);
      if (updated < session.open || updated >= session.close || updated > now + 5000 || now - updated > 300_000) { result.warnings.push(`${feed.label} discovery is stale or belongs to another session.`); return; }
      const found = (body[feed.field] as unknown[]).slice(0, feed.limit).flatMap(value => record(value) && typeof value.symbol === 'string' && SYMBOL.test(value.symbol) ? [value.symbol] : []);
      result.symbols.push(...found); result[feed.count] = new Set(found).size;
      result.updatedAt = result.updatedAt === null ? updated : Math.min(result.updatedAt, updated);
    });
    result.symbols = [...new Set(result.symbols)];
    return result;
  }

  async getSnapshots(values: string[], signal?: AbortSignal): Promise<Record<string, ScannerSnapshot>> {
    const symbols = normalizeSymbols(values);
    const result: Record<string, ScannerSnapshot> = {};
    await this.batches(symbols, async batch => {
      const body = await this.request(DATA_HOST, `/v2/stocks/snapshots?${new URLSearchParams({ symbols: batch.join(','), feed: 'sip' })}`, signal);
      if (!record(body)) throw new Error('Alpaca returned incomplete scanner snapshots.');
      for (const symbol of batch) {
        const value = body[symbol], prior = record(value) ? value.prevDailyBar : null;
        result[symbol] = { previousClose: record(prior) && positive(prior.c) ? prior.c : null };
      }
    });
    return result;
  }

  /** Same shared SIP snapshots endpoint, without inventing a trade from a quote or candle. */
  async getResearchQuotes(values: string[], signal?: AbortSignal): Promise<Record<string, ResearchQuote>> {
    const symbols = normalizeSymbols(values), result: Record<string, ResearchQuote> = {};
    await this.batches(symbols, async batch => {
      const body = await this.request(DATA_HOST, `/v2/stocks/snapshots?${new URLSearchParams({ symbols: batch.join(','), feed: isOvernightTime(this.now()) ? 'boats' : 'sip' })}`, signal);
      if (!record(body)) throw new Error('Alpaca returned incomplete research snapshots.');
      for (const symbol of batch) {
        const value = body[symbol];
        const trade = record(value) && record(value.latestTrade) ? value.latestTrade : {};
        const quote = record(value) && record(value.latestQuote) ? value.latestQuote : {};
        result[symbol] = {
          price: positive(trade.p) ? trade.p : null, tradeAt: timestamp(trade.t) ? new Date(trade.t).toISOString() : null,
          bid: positive(quote.bp) ? quote.bp : null, ask: positive(quote.ap) ? quote.ap : null,
          quoteAt: timestamp(quote.t) ? new Date(quote.t).toISOString() : null,
        };
      }
    });
    return result;
  }

  /** Recheck on refresh: Alpaca warns corporate-action reporting can be delayed. Cache only after success. */
  async getSplitFingerprint(values: string[], startDate: string, endDate: string, signal?: AbortSignal): Promise<Record<string, string>> {
    this.validateDates(startDate, endDate);
    const symbols = normalizeSymbols(values), result: Record<string, string> = {};
    await this.batches(symbols, async batch => {
      const events = new Map(batch.map(symbol => [symbol, new Set<string>()]));
      const unsupported = new Set<string>();
      const params = new URLSearchParams({ symbols: batch.join(','), types: 'forward_split,reverse_split,unit_split', start: startDate, end: endDate, limit: '1000', sort: 'asc' });
      const seen = new Set<string>();
      let token: string | null;
      do {
        const page = await this.request(DATA_HOST, `/v1/corporate-actions?${params}`, signal);
        if (!record(page) || !record(page.corporate_actions)) throw new Error('Corporate-action checks are incomplete; cached scanner profiles cannot be trusted.');
        for (const [group, rows] of Object.entries(page.corporate_actions)) {
          if (!['forward_splits', 'reverse_splits', 'unit_splits'].includes(group) || !Array.isArray(rows)) throw new Error('Alpaca returned an invalid split response.');
          for (const row of rows) {
            if (!record(row) || !dateValid(row.process_date) || !positive(row.new_rate) || !positive(row.old_rate)) throw new Error('Alpaca returned an incomplete split record.');
            const affected = group === 'unit_splits' ? [row.old_symbol, row.new_symbol, row.alternate_symbol] : [row.symbol];
            if (affected.some(symbol => typeof symbol !== 'string' || !SYMBOL.test(symbol))) throw new Error('Alpaca returned an incomplete split symbol.');
            const effective = group === 'unit_splits' ? row.effective_date : row.ex_date;
            if (!dateValid(effective)) throw new Error('Alpaca returned an incomplete split effective date.');
            if (effective > endDate) continue;
            for (const symbol of affected as string[]) if (events.has(symbol)) {
              events.get(symbol)!.add(`${group}:${stableJson(row)}`);
              if (group === 'unit_splits') unsupported.add(symbol);
            }
          }
        }
        token = nextToken(page, seen);
        if (token) params.set('page_token', token);
      } while (token);
      for (const [symbol, rows] of events) result[symbol] = `${unsupported.has(symbol) ? 'unsupported-unit-split:' : ''}${[...rows].sort().join('|') || 'none'}`;
    });
    return result;
  }

  private validateDates(start: string, end: string): void {
    if (!dateValid(start) || !dateValid(end) || end < start) throw new Error('Invalid scanner calendar interval.');
  }

  private async batches(values: string[], action: (batch: string[]) => Promise<void>, size = BATCH_SIZE): Promise<void> {
    const batches = Array.from({ length: Math.ceil(values.length / size) }, (_, index) => values.slice(index * size, (index + 1) * size));
    // Bound tasks as well as HTTP requests: a large asset list must not allocate an unbounded queue.
    let index = 0, stopped = false;
    await Promise.all(Array.from({ length: Math.min(this.concurrency, batches.length) }, async () => {
      while (!stopped && index < batches.length) {
        try { await action(batches[index++]); }
        catch (error) { stopped = true; throw error; }
      }
    }));
  }

  private request(host: string, path: string, signal?: AbortSignal): Promise<unknown> {
    if (this.disposed || signal?.aborted) return Promise.reject(abortError());
    const url = host + path;
    let shared = this.pending.get(url);
    if (shared?.controller.signal.aborted) { this.pending.delete(url); shared = undefined; }
    if (!shared) {
      const controller = new AbortController();
      shared = { controller, promise: this.perform(url, controller.signal), consumers: 0 };
      this.pending.set(url, shared);
      const entry = shared;
      void shared.promise.finally(() => { if (this.pending.get(url) === entry) this.pending.delete(url); }).catch(() => undefined);
    }
    shared.consumers++;
    const entry = shared;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (action: () => void) => {
        if (settled) return;
        settled = true; signal?.removeEventListener('abort', abort);
        if (--entry.consumers === 0) entry.controller.abort();
        action();
      };
      const abort = () => finish(() => reject(abortError()));
      signal?.addEventListener('abort', abort, { once: true });
      entry.promise.then(value => finish(() => resolve(value)), error => finish(() => reject(error)));
      if (signal?.aborted) abort();
    });
  }

  private async perform(url: string, signal: AbortSignal): Promise<unknown> {
    await this.acquire(signal);
    try {
      const reserved = Math.max(this.now(), this.nextStart);
      this.nextStart = reserved + this.interval;
      if (reserved > this.now()) await this.delay(reserved - this.now(), signal);
      return await this.transport.request(url, { signal, retries: this.retries });
    } finally { this.release(); }
  }

  private acquire(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(abortError());
    if (this.active < this.concurrency) { this.active++; return Promise.resolve(); }
    return new Promise((resolve, reject) => {
      const item = {
        run: () => { signal.removeEventListener('abort', item.cancel); this.active++; resolve(); },
        cancel: () => { const index = this.queue.indexOf(item); if (index >= 0) this.queue.splice(index, 1); reject(abortError()); },
      };
      this.queue.push(item); signal.addEventListener('abort', item.cancel, { once: true });
    });
  }

  private release(): void { this.active--; this.queue.shift()?.run(); }

  private delay(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
      const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(abortError()); };
      const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, Math.min(ms, 2_147_483_647));
      signal.addEventListener('abort', abort, { once: true });
    });
  }
}
