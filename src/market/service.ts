import { fullTradingSession, FULL_SESSION_CALENDAR } from '../core/exchange-session';
import type { DataReads, MarketReads, MarketStream } from '../broker/reads';
import { MarketDataUnavailableError } from '../core/market-data';
import type { StockFeed } from '../core/stream';
import type { Bar, Quote, Timeframe } from '../core/types';
import type { RobotProposal, RobotSession } from '../robots/domain';
import { templates } from '../robots/templates/registry';
import { freshQuote, type ExecutionQuote } from '../core/quote';
import { RobotData } from './robot-data';
import { ChartHistory } from './chart-history';
import { isOvernightTime } from '../core/trading-session';
import { WATCHLIST_LOOKBACK_MS } from './watchlist-history';

export interface MarketModel { quotes: Readonly<Record<string, Quote>>; status: string; error: string; feed: StockFeed }
export class Market {
  private disposed = false;
  private authenticated = false;
  private generation = 0;
  private quotes: Record<string, Quote> = {};
  private facts = new Map<string, ExecutionQuote>();
  private symbols: string[] = [];
  private listeners = new Set<() => void>();
  private readonly unsubscribe: () => void;
  private readonly displayTimer: ReturnType<typeof setInterval>;
  private readonly pollTimer: ReturnType<typeof setInterval>;
  private readonly controller = new AbortController();
  private polling = false;
  private dirty = false;
  private readonly robotData: RobotData;
  private quoteRequests = new Map<string, Promise<void>>();
  private readonly charts: ChartHistory;
  model: MarketModel;
  constructor(private readonly reads: MarketReads, private readonly critical: DataReads,
    private readonly stream: MarketStream, private readonly routeFeed: (feed: StockFeed) => void,
    private readonly now: () => number = Date.now) {
    this.model = { quotes: {}, status: 'connecting', error: '', feed: this.expectedFeed() };
    this.charts = new ChartHistory(reads.getBars.bind(reads), now);
    this.robotData = new RobotData(critical, this.controller.signal, now);
    this.unsubscribe = stream.addListener({
      onStatus: (status, error) => {
        if (this.disposed) return;
        this.authenticated = status === 'ready';
        // Subscription changes keep the authenticated feed and existing observations.
        // Readiness still waits for acknowledgement, and quote/cache ages still expire.
        if (!this.authenticated && status !== 'subscribing') { this.generation++; this.facts.clear(); this.robotData.clear(); this.quoteRequests.clear(); }
        this.model = { ...this.model, status, error: ['error', 'disconnected'].includes(status) ? error : '' }; this.publish();
      },
      onTrade: trade => {
        if (this.disposed) return;
        const at = Date.parse(trade.timestamp), prior = this.facts.get(trade.symbol);
        if (prior?.tradeAt && at < prior.tradeAt) return;
        const fact = prior ?? this.empty(trade.symbol);
        this.facts.set(trade.symbol, { ...fact, price: trade.price, tradeAt: at, receivedAt: this.now() });
        const quote = this.quotes[trade.symbol];
        const previousClose = quote?.previousClose ?? null, change = previousClose === null ? null : trade.price - previousClose;
        this.quotes[trade.symbol] = { symbol: trade.symbol, price: trade.price, previousClose, change,
          changePercent: change === null || previousClose === null ? null : change / previousClose * 100,
          bid: fact.bid, ask: fact.ask, volume: quote?.volume ?? null, high: quote?.high ?? null, low: quote?.low ?? null, timestamp: trade.timestamp };
        this.dirty = true;
      },
      onQuote: quote => {
        if (this.disposed) return;
        const at = Date.parse(quote.timestamp), prior = this.facts.get(quote.symbol);
        if (prior?.quoteAt && at < prior.quoteAt) return;
        this.facts.set(quote.symbol, { ...(prior ?? this.empty(quote.symbol)), bid: quote.bid, ask: quote.ask, quoteAt: at, receivedAt: this.now() });
        if (this.quotes[quote.symbol]) this.quotes[quote.symbol] = { ...this.quotes[quote.symbol], bid: quote.bid, ask: quote.ask };
        this.dirty = true;
      },
    });
    this.displayTimer = setInterval(() => { if (this.dirty) { this.model = { ...this.model, quotes: { ...this.quotes } }; this.dirty = false; this.publish(); } }, 250);
    this.pollTimer = setInterval(() => { this.syncFeed(); void this.refresh(); }, 15_000);
  }
  get feed(): StockFeed { return this.model.feed; }
  private expectedFeed(): StockFeed { return isOvernightTime(this.now()) ? 'boats' : 'sip'; }
  private syncFeed(): void {
    const feed = this.expectedFeed(); if (this.disposed || feed === this.feed) return;
    this.generation++; this.authenticated = false; this.facts.clear(); this.quotes = {}; this.charts.clear();
    this.robotData.clear(); this.quoteRequests.clear();
    this.model = { quotes: {}, status: 'connecting', error: '', feed }; this.publish(); this.routeFeed(feed);
  }
  private empty(symbol: string): ExecutionQuote { return { symbol, price: null, bid: null, ask: null, tradeAt: null, quoteAt: null, receivedAt: 0, feed: this.feed }; }
  ready(): boolean { return !this.disposed && this.authenticated && this.feed === this.expectedFeed(); }
  quote(symbol: string): ExecutionQuote | null { return this.facts.get(symbol) ?? null; }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private publish(): void { if (!this.disposed) for (const listener of this.listeners) listener(); }
  watch(symbols: string[]): void {
    if (this.disposed) return;
    const next = [...new Set(symbols)].slice(0, 300).sort();
    if (next.join(',') === this.symbols.join(',')) return;
    this.symbols = next;
    this.stream.setOwnerSubscriptions('market', { trades: this.symbols, quotes: this.symbols });
    const keep = new Set(this.symbols);
    for (const symbol of this.facts.keys()) if (!keep.has(symbol)) this.facts.delete(symbol);
    for (const symbol of Object.keys(this.quotes)) if (!keep.has(symbol)) delete this.quotes[symbol];
    void this.refresh();
  }
  async refresh(): Promise<void> {
    if (this.disposed || this.polling || !this.symbols.length) return;
    this.polling = true;
    try {
      const values = await this.reads.getSnapshots(this.symbols);
      if (this.disposed) return;
      for (const [symbol, quote] of Object.entries(values)) {
        const previous = this.quotes[symbol];
        this.quotes[symbol] = previous && Date.parse(previous.timestamp) > Date.parse(quote.timestamp)
          ? { ...quote, price: previous.price, timestamp: previous.timestamp, bid: previous.bid, ask: previous.ask } : quote;
      }
      this.dirty = true;
    } catch (error) { if (!this.disposed) { this.model = { ...this.model, error: error instanceof Error ? error.message : 'Quotes unavailable.' }; this.publish(); } }
    finally { this.polling = false; }
  }
  async bars(symbol: string, timeframe: Timeframe, signal: AbortSignal): Promise<Bar[]> {
    const feed = this.feed;
    const bars = await this.charts.getBars(symbol, timeframe, { signal });
    if (this.disposed || signal.aborted || feed !== this.feed) throw new DOMException('Chart request cancelled.', 'AbortError');
    return bars;
  }
  async watchlistBars(symbol: string, signal: AbortSignal): Promise<Bar[]> {
    if (this.disposed || signal.aborted) throw new DOMException('Watchlist request cancelled.', 'AbortError');
    const bars = await this.reads.getBars(symbol, '5Min', {
      start: new Date(this.now() - WATCHLIST_LOOKBACK_MS).toISOString(), includeOvernight: true, signal,
    });
    if (this.disposed || signal.aborted) throw new DOMException('Watchlist request cancelled.', 'AbortError');
    return bars;
  }
  async snapshot(plan: RobotProposal) {
    if (!this.ready()) throw new MarketDataUnavailableError('Robots require current real-time market data.');
    const feed = this.feed, generation = this.generation;
    const date = plan.session.tradingDate;
    const capabilities = templates.find(template => template.identity.id === plan.template.id)?.requiredCapabilities ?? [];
    const [assets, calendar, , bars] = await Promise.all([
      this.robotData.eligibleAssets(), this.robotData.calendar(date), this.refreshRobotQuote(plan.symbol),
      capabilities.includes('completed_5min_bars') ? this.robotData.bars(plan.symbol, date, plan.sessionMode === '24x5').catch(() => []) : Promise.resolve([]),
    ]).catch(error => {
      if (!this.ready() || generation !== this.generation) throw new MarketDataUnavailableError('Market data feed changed during observation.');
      throw error;
    });
    if (this.disposed) throw new Error('This market session is closed.');
    if (!this.ready() || feed !== this.feed || generation !== this.generation) throw new MarketDataUnavailableError('Market data feed changed during observation.');
    const asset = assets.find(asset => asset.symbol === plan.symbol);
    if (!asset || feed === 'boats' && !asset.overnightTradable) throw new Error('The approved symbol is no longer a tradable US equity.');
    const regular = calendar.values.find(value => value.date === date), today = regular && (plan.sessionMode === '24x5' ? fullTradingSession(regular) : regular);
    const session: RobotSession | null = today ? { calendarId: plan.sessionMode === '24x5' ? FULL_SESSION_CALENDAR : 'alpaca-us-equity', tradingDate: today.date, timeZone: 'America/New_York',
      openAt: new Date(today.open).toISOString(), closeAt: new Date(today.close).toISOString(), calendarAsOf: new Date(calendar.at).toISOString(), provenanceRef: `calendar/${date}` } : null;
    const quote = this.quote(plan.symbol);
    return { inputRef: `market-${crypto.randomUUID()}`, symbol: plan.symbol, dataCutoff: new Date(this.now()).toISOString(),
      session, assetClass: 'us_equity' as const, capabilities,
      quote: freshQuote(quote, this.now(), 'limit', true) ? { at: new Date(Math.min(quote!.tradeAt!, quote!.quoteAt!)).toISOString(),
        priceUsd: quote!.price!, bidUsd: quote!.bid, askUsd: quote!.ask } : null, bars };
  }
  private async refreshRobotQuote(symbol: string): Promise<void> {
    if (freshQuote(this.quote(symbol), this.now(), 'limit', true)) return;
    const pending = this.quoteRequests.get(symbol); if (pending) return pending;
    const feed = this.feed, generation = this.generation;
    const request = this.critical.getResearchQuotes([symbol], this.controller.signal).then(values => {
      if (!this.ready() || feed !== this.feed || generation !== this.generation) throw new MarketDataUnavailableError('Market feed changed during quote observation.');
      const quote = values[symbol]; if (!quote) return;
      const prior = this.quote(symbol) ?? this.empty(symbol);
      const tradeAt = quote.tradeAt ? Date.parse(quote.tradeAt) : null, quoteAt = quote.quoteAt ? Date.parse(quote.quoteAt) : null;
      this.facts.set(symbol, { ...prior, receivedAt: this.now(), feed,
        ...(tradeAt !== null && tradeAt >= (prior.tradeAt ?? -Infinity) ? { price: quote.price, tradeAt } : {}),
        ...(quoteAt !== null && quoteAt >= (prior.quoteAt ?? -Infinity) ? { bid: quote.bid, ask: quote.ask, quoteAt } : {}) });
    });
    this.quoteRequests.set(symbol, request);
    try { await request; } finally { if (this.quoteRequests.get(symbol) === request) this.quoteRequests.delete(symbol); }
  }
  dispose(): void {
    this.disposed = true; this.controller.abort(); clearInterval(this.displayTimer); clearInterval(this.pollTimer);
    this.charts.dispose();
    this.robotData.clear(); this.quoteRequests.clear();
    this.unsubscribe(); this.stream.removeOwner('market'); this.listeners.clear(); this.facts.clear();
  }
}
