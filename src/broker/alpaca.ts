import { CHART_LOOKBACK, MAX_CHART_BARS } from '../core/bar-history';
import { isOvernightTime } from '../core/trading-session';
import { executionRulesError } from '../core/orders';
import type { Account, Bar, Credentials, MarketClock, Order, OrderRequest, Period, PortfolioHistory, Position, Quote, Timeframe, TradeActivitiesPage, TradeActivity } from '../core/types';
import { AlpacaRequestError, BrokerTransport } from './http';
import type { ApiActivity } from '../core/api-activity';
export { AlpacaRequestError } from './http';

type JsonObject = Record<string, unknown>;
const PAPER_URL = 'https://paper-api.alpaca.markets';
const LIVE_URL = 'https://api.alpaca.markets';
const DATA_URL = 'https://data.alpaca.markets';
const MAX_BARS = 400;
const BAR_LOOKBACK: Record<Timeframe, number> = { '1Min': 5, '5Min': 14, '15Min': 21, '1Hour': 90, '1Day': 600, '1Week': 3000 };
const ACTIVITY_PAGE_SIZE = 100;
const CASH_TRANSFER_TYPES = ['CSD', 'CSW', 'JNLC', 'ACATC'] as const;

const object = (value: unknown): JsonObject => value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
const string = (value: unknown): string => typeof value === 'string' ? value : '';
const isNumeric = (value: unknown): boolean => (typeof value === 'number' || (typeof value === 'string' && value.trim() !== '')) && Number.isFinite(Number(value));
const nullableNumeric = (value: unknown): number | null => isNumeric(value) ? Number(value) : null;
const optionalNumeric = (value: unknown): number | undefined => nullableNumeric(value) ?? undefined;
const positiveNumeric = (value: unknown): number | null => isNumeric(value) && Number(value) > 0 ? Number(value) : null;
const nonnegativeNumeric = (value: unknown): number | null => isNumeric(value) && Number(value) >= 0 ? Number(value) : null;
const timestamp = (value: unknown): string | null => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value)) ? value : null;
const identifier = (value: unknown): string | null => typeof value === 'string' && value.trim().length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value) ? value : null;

function symbol(value: string): string {
  const normalized = value.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9.-]{0,14}$/.test(normalized)) throw new Error('Enter a valid US stock or ETF ticker.');
  return normalized;
}

function mapOrder(value: unknown, parentOrderId?: string): Order {
  const data = object(value);
  if (!string(data.id) || !string(data.symbol) || !string(data.status) || (data.side !== 'buy' && data.side !== 'sell')) {
    throw new Error('Alpaca returned an incomplete order. Refresh orders before trying again.');
  }
  if (data.legs != null && (!Array.isArray(data.legs) || data.legs.length > 2 || parentOrderId !== undefined && data.legs.length > 0)) {
    throw new Error('Alpaca returned invalid attached orders. Reconcile before trading.');
  }
  return {
    id: string(data.id), symbol: string(data.symbol), qty: nonnegativeNumeric(data.qty), filledQty: nonnegativeNumeric(data.filled_qty),
    side: data.side === 'sell' ? 'sell' : 'buy', type: string(data.type) as Order['type'], status: string(data.status),
    submittedAt: string(data.submitted_at) || string(data.created_at), filledAvgPrice: optionalNumeric(data.filled_avg_price),
    limitPrice: optionalNumeric(data.limit_price), clientOrderId: identifier(data.client_order_id) ?? undefined, filledAt: timestamp(data.filled_at),
    updatedAt: timestamp(data.updated_at),
    stopPrice: optionalNumeric(data.stop_price), timeInForce: string(data.time_in_force) || undefined,
    orderClass: string(data.order_class) || undefined, extendedHours: data.extended_hours === true, ...(parentOrderId ? { parentOrderId } : {}),
    ...(Array.isArray(data.legs) ? { legs: data.legs.map(leg => mapOrder(leg, string(data.id))) } : {}),
  };
}

function mapTradeActivity(value: unknown): TradeActivity {
  const data = object(value);
  const id = identifier(data.id), orderId = identifier(data.order_id), ticker = identifier(data.symbol);
  const transactionTime = timestamp(data.transaction_time);
  const qty = positiveNumeric(data.qty), price = positiveNumeric(data.price);
  if (data.activity_type !== 'FILL' || !id || !orderId || !ticker || !transactionTime || qty === null || price === null ||
    (data.side !== 'buy' && data.side !== 'sell') || (data.type !== 'fill' && data.type !== 'partial_fill')) {
    throw new Error('Alpaca returned incomplete trade activity data. Trade history import is incomplete.');
  }
  return { id, orderId, symbol: ticker, side: data.side, qty, price, transactionTime, type: data.type };
}

function mapBar(value: unknown): Bar | null {
  const item = object(value);
  const t = string(item.t);
  if (!Number.isFinite(Date.parse(t)) || ['o', 'h', 'l', 'c'].some(key => positiveNumeric(item[key]) === null) || nonnegativeNumeric(item.v) === null) return null;
  const o = Number(item.o), h = Number(item.h), l = Number(item.l), c = Number(item.c), v = Number(item.v);
  if (h < Math.max(o, l, c) || l > Math.min(o, h, c)) return null;
  return { t, o, h, l, c, v };
}

/** Direct browser REST adapter. Credentials live only in this instance and are cleared on dispose. */
export class AlpacaApi {
  readonly environment: 'paper' | 'live';
  private readonly baseUrl: string;
  private readonly transport: BrokerTransport;
  private disposed = false;
  private accountCreatedAt: string | null | undefined;

  constructor(credentials: Credentials, activity?: ApiActivity) {
    if (credentials.environment !== 'paper' && credentials.environment !== 'live') throw new Error('Choose a paper or live account.');
    if (!credentials.keyId.trim() || !credentials.secretKey.trim()) throw new Error('Both the API key and secret are required.');
    if (/[\r\n]/.test(credentials.keyId + credentials.secretKey)) throw new Error('API credentials must not contain line breaks.');
    this.environment = credentials.environment;
    this.baseUrl = credentials.environment === 'live' ? LIVE_URL : PAPER_URL;
    this.transport = new BrokerTransport(credentials, undefined, activity);
  }

  dispose(): void {
    this.disposed = true;
    this.transport.dispose();
    this.accountCreatedAt = undefined;
  }

  abortReads(): void { this.transport.abortReads(); }
  private cleanMessage(message: string): string { return this.transport.clean(message); }
  private request(path: string, options: { method?: 'GET' | 'POST' | 'DELETE'; body?: unknown; data?: boolean; signal?: AbortSignal } = {}): Promise<unknown> {
    if (this.disposed) return Promise.reject(new Error('This connection is closed.'));
    return this.transport.request((options.data ? DATA_URL : this.baseUrl) + path, options);
  }

  private mapSubmittedOrder(value: unknown): Order {
    try { return mapOrder(value); }
    catch (error) {
      // A successful write with an invalid body may already have executed.
      throw new AlpacaRequestError(this.cleanMessage(error instanceof Error ? error.message : 'Alpaca returned an incomplete order.'), true);
    }
  }

  async getAccount(): Promise<Account> {
    const data = object(await this.request('/v2/account'));
    if (['equity', 'last_equity', 'buying_power', 'cash'].some(key => !isNumeric(data[key])) || typeof data.trading_blocked !== 'boolean' || !string(data.status)) {
      throw new Error('Alpaca returned incomplete account data. Trading is paused until balances are available.');
    }
    this.accountCreatedAt = timestamp(data.created_at);
    return {
      id: typeof data.id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(data.id) ? data.id : null,
      equity: Number(data.equity), lastEquity: Number(data.last_equity), buyingPower: Number(data.buying_power), regtBuyingPower: nonnegativeNumeric(data.regt_buying_power),
      cash: Number(data.cash), portfolioValue: nullableNumeric(data.portfolio_value), daytradeCount: nonnegativeNumeric(data.daytrade_count),
      tradingBlocked: data.trading_blocked === true || data.account_blocked === true || data.trade_suspended_by_user === true || (typeof data.status === 'string' && data.status !== 'ACTIVE'),
      createdAt: this.accountCreatedAt,
    };
  }

  async getPositions(): Promise<Position[]> {
    const data = await this.request('/v2/positions');
    if (!Array.isArray(data)) throw new Error('Alpaca returned incomplete position data.');
    return data.map(value => {
      const item = object(value);
      if (!string(item.symbol) || !isNumeric(item.qty) || !isNumeric(item.avg_entry_price) || (item.side !== 'long' && item.side !== 'short')) {
        throw new Error('Alpaca returned incomplete position data. Trading is paused until holdings are available.');
      }
      return {
        symbol: string(item.symbol), qty: Number(item.qty), avgEntryPrice: Number(item.avg_entry_price), currentPrice: nullableNumeric(item.current_price),
        marketValue: nullableNumeric(item.market_value), unrealizedPl: nullableNumeric(item.unrealized_pl), unrealizedPlpc: nullableNumeric(item.unrealized_plpc),
        side: item.side === 'short' ? 'short' : 'long',
      };
    });
  }

  async getOrders(): Promise<Order[]> {
    // Open orders need a separate query: an old GTC order can be older than hundreds of filled orders.
    const [open, closed] = await Promise.all([
      this.request('/v2/orders?status=open&limit=500&direction=desc&nested=true'),
      this.request('/v2/orders?status=closed&limit=100&direction=desc&nested=true'),
    ]);
    if (!Array.isArray(open) || !Array.isArray(closed)) throw new Error('Alpaca returned incomplete order data.');
    // The endpoint only supports exclusive timestamp pagination. At the cap, timestamp ties can
    // hide an order, so fail closed instead of presenting a possibly incomplete pending set.
    if (open.length >= 500) throw new Error('500 or more open orders prevent a complete safety check. Reduce open orders in Alpaca before trading here.');
    // Keep the public list flat for account conflict checks, while retaining legs
    // on each parent so all Robots can reconcile from the same broker batch.
    const flatten = (values: unknown[]): Order[] => values.flatMap(value => { const order = mapOrder(value); return [order, ...(order.legs ?? [])]; });
    const pending = [...new Map(flatten(open).map(order => [order.id, order])).values()];
    const pendingIds = new Set(pending.map(order => order.id));
    // Pending orders first also keeps old orders accessible in the terminal's compact table.
    return [...pending, ...[...new Map(flatten(closed).map(order => [order.id, order])).values()].filter(order => !pendingIds.has(order.id))];
  }

  async getOrder(id: string): Promise<Order> {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error('The order ID is invalid.');
    const order = mapOrder(await this.request(`/v2/orders/${encodeURIComponent(id)}?nested=true`));
    if (order.id !== id) throw new Error('Alpaca returned a different order. Refresh orders before trying again.');
    return order;
  }

  /** One broker page of executions, including separate partial fills per order. */
  async getTradeActivities(options: { after?: string; pageToken?: string } = {}): Promise<TradeActivitiesPage> {
    const query = new URLSearchParams({ page_size: String(ACTIVITY_PAGE_SIZE), direction: 'desc' });
    if (options.after !== undefined) {
      if (!timestamp(options.after) && !(/^\d{4}-\d{2}-\d{2}$/.test(options.after) && Number.isFinite(Date.parse(options.after)))) {
        throw new Error('Choose a valid trade history start date.');
      }
      query.set('after', options.after);
    }
    if (options.pageToken !== undefined) {
      if (!identifier(options.pageToken)) throw new Error('The trade history page token is invalid.');
      query.set('page_token', options.pageToken);
    }
    const data = await this.request(`/v2/account/activities/FILL?${query}`);
    if (!Array.isArray(data) || data.length > ACTIVITY_PAGE_SIZE) throw new Error('Alpaca returned an invalid trade history page. Import is incomplete.');
    const activities = data.map(mapTradeActivity);
    const ids = new Set(activities.map(activity => activity.id));
    if (ids.size !== activities.length || (options.pageToken && ids.has(options.pageToken))) {
      throw new Error('Alpaca returned a repeated trade history cursor. Import is incomplete.');
    }
    return { activities, nextPageToken: activities.length === ACTIVITY_PAGE_SIZE ? activities.at(-1)!.id : null };
  }

  async getClock(): Promise<MarketClock> {
    const data = object(await this.request('/v2/clock'));
    if (typeof data.is_open !== 'boolean' || ![data.timestamp, data.next_open, data.next_close].every(value => timestamp(value))) throw new Error('Alpaca returned incomplete market-clock data.');
    return { isOpen: data.is_open, timestamp: new Date(string(data.timestamp)).toISOString(),
      nextOpen: new Date(string(data.next_open)).toISOString(), nextClose: new Date(string(data.next_close)).toISOString() };
  }

  async getSnapshots(symbols: string[]): Promise<Record<string, Quote>> {
    const tickers = [...new Set(symbols.map(symbol))];
    if (!tickers.length) return {};
    const feed = isOvernightTime() ? 'boats' : 'sip';
    const query = new URLSearchParams({ symbols: tickers.join(','), feed });
    const snapshots = object(await this.request(`/v2/stocks/snapshots?${query}`, { data: true }));
    const result: Record<string, Quote> = {};
    for (const ticker of tickers) {
      const snapshot = object(snapshots[ticker]);
      const trade = object(snapshot.latestTrade);
      const quote = object(snapshot.latestQuote);
      const minute = object(snapshot.minuteBar);
      const daily = object(snapshot.dailyBar);
      const previous = object(snapshot.prevDailyBar);
      const candidates = [
        { price: positiveNumeric(trade.p), timestamp: string(trade.t) },
        { price: positiveNumeric(minute.c), timestamp: string(minute.t) },
        { price: positiveNumeric(daily.c), timestamp: string(daily.t) },
      ].filter((candidate): candidate is { price: number; timestamp: string } => candidate.price !== null && Number.isFinite(Date.parse(candidate.timestamp)));
      candidates.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
      const latest = candidates[0];
      if (!latest) continue;
      const previousClose = positiveNumeric(previous.c);
      const change = previousClose !== null ? latest.price - previousClose : null;
      result[ticker] = {
        symbol: ticker, price: latest.price, previousClose, change, changePercent: previousClose !== null && change !== null ? change / previousClose * 100 : null,
        bid: positiveNumeric(quote.bp), ask: positiveNumeric(quote.ap), volume: nonnegativeNumeric(daily.v),
        high: positiveNumeric(daily.h), low: positiveNumeric(daily.l), timestamp: latest.timestamp,
      };
    }
    return result;
  }

  async getBars(ticker: string, timeframe: Timeframe, options: { extendedHistory?: boolean; includeOvernight?: boolean; signal?: AbortSignal; start?: string } = {}): Promise<Bar[]> {
    const lookback = options.extendedHistory ? CHART_LOOKBACK : BAR_LOOKBACK;
    if (!(timeframe in lookback)) throw new Error('Choose a supported chart interval.');
    const normalized = symbol(ticker), now = Date.now();
    const start = new Date(Math.max(now - lookback[timeframe] * 86_400_000, options.start ? Date.parse(options.start) : 0)).toISOString();
    const maxBars = options.extendedHistory ? MAX_CHART_BARS : MAX_BARS;
    const history = (feed: 'sip' | 'boats', end?: string) => this.getBarsForFeed(normalized, timeframe, start, feed, maxBars, end, options.signal);
    const histories = [history('sip')];
    if ((isOvernightTime(now) || options.includeOvernight) && timeframe !== '1Day' && timeframe !== '1Week') {
      histories.push(history('boats', new Date(now).toISOString()));
    }
    const bars = new Map<string, Bar>();
    for (const history of await Promise.all(histories)) for (const bar of history) bars.set(bar.t, bar);
    return [...bars.values()].sort((a, b) => Date.parse(a.t) - Date.parse(b.t)).slice(-maxBars);
  }

  private async getBarsForFeed(ticker: string, timeframe: Timeframe, start: string, feed: 'sip' | 'boats', maxBars: number, end?: string, signal?: AbortSignal): Promise<Bar[]> {
    const query = new URLSearchParams({
      timeframe, start, limit: String(maxBars), adjustment: 'split', feed, sort: 'desc',
    });
    if (end) query.set('end', end);
    const bars = new Map<string, Bar>();
    const seenTokens = new Set<string>();
    for (let page = 0; page < 100 && bars.size < maxBars; page++) {
      const data = object(await this.request(`/v2/stocks/${encodeURIComponent(ticker)}/bars?${query}`, { data: true, signal }));
      for (const value of Array.isArray(data.bars) ? data.bars : []) {
        const bar = mapBar(value);
        if (bar) bars.set(bar.t, bar);
      }
      const token = string(data.next_page_token);
      if (!token || bars.size >= maxBars) break;
      if (seenTokens.has(token)) throw new Error('Alpaca returned a repeated chart history cursor. Try refreshing.');
      if (page === 99) throw new Error('Chart history exceeded the paging limit. Try refreshing.');
      seenTokens.add(token);
      query.set('page_token', token);
    }
    return [...bars.values()].sort((a, b) => Date.parse(a.t) - Date.parse(b.t)).slice(-maxBars);
  }

  async getPortfolioHistory(period: Period): Promise<PortfolioHistory> {
    const resolutions: Record<Period, string> = { '1D': '1Min', '1W': '5Min', '1M': '15Min', ALL: '1D' };
    if (!(period in resolutions)) throw new Error('Choose a supported portfolio period.');
    const query = new URLSearchParams({
      timeframe: resolutions[period], pnl_reset: 'no_reset', intraday_reporting: 'extended_hours',
      cashflow_types: CASH_TRANSFER_TYPES.join(','),
    });
    if (period === 'ALL') {
      if (this.accountCreatedAt === undefined) await this.getAccount();
      const now = Date.now(), age = this.accountCreatedAt ? now - Date.parse(this.accountCreatedAt) : NaN;
      if (!Number.isFinite(age) || age < 0) {
        throw new Error('Alpaca account creation date is unavailable. All-time portfolio history cannot be requested.');
      }
      // Preserve the complete lifetime. Recent accounts can use intraday data;
      // Alpaca only supports daily history for windows longer than 30 days.
      query.set('timeframe', age <= 86_400_000 ? '1Min' : age <= 7 * 86_400_000 ? '5Min' : age <= 30 * 86_400_000 ? '15Min' : '1D');
      query.set('start', this.accountCreatedAt!);
      query.set('end', new Date(now).toISOString());
    } else {
      // A calendar month may span 31 days, beyond Alpaca's intraday limit.
      query.set('period', period === '1M' ? '30D' : period);
    }
    const data = object(await this.request(`/v2/account/portfolio/history?${query}`));
    if (![data.timestamp, data.equity, data.profit_loss].every(Array.isArray)) {
      throw new Error('Alpaca returned incomplete portfolio history. History import is incomplete.');
    }
    const timestamps = Array.isArray(data.timestamp) ? data.timestamp : [];
    const equity = Array.isArray(data.equity) ? data.equity : [];
    const profitLoss = Array.isArray(data.profit_loss) ? data.profit_loss : [];
    const profitLossPct = Array.isArray(data.profit_loss_pct) ? data.profit_loss_pct : [];
    const result: PortfolioHistory = { timestamp: [], equity: [], profitLoss: [], profitLossPct: [], baseValue: nullableNumeric(data.base_value) };
    if (data.cashflow != null && (typeof data.cashflow !== 'object' || Array.isArray(data.cashflow))) {
      throw new Error('Alpaca returned incomplete cash transfer history. Portfolio P/L is unavailable.');
    }
    const cashflow = object(data.cashflow);
    const transfers = timestamps.map(() => 0);
    for (const type of CASH_TRANSFER_TYPES) {
      const amounts = cashflow[type];
      if (amounts === undefined) continue;
      if (!Array.isArray(amounts) || amounts.length !== timestamps.length || amounts.some(amount => !isNumeric(amount))) {
        throw new Error('Alpaca returned incomplete cash transfer history. Portfolio P/L is unavailable.');
      }
      amounts.forEach((amount, index) => { transfers[index] += Number(amount); });
    }
    if (transfers.some(amount => amount !== 0) && result.baseValue === null) {
      throw new Error('Alpaca portfolio baseline is unavailable. P/L excluding cash transfers cannot be calculated.');
    }
    // cashflow contains amounts for each window, not a cumulative balance. The
    // query requests transfers only: dividends, interest, and fees remain in P/L.
    // Without a prior closing baseline, initial funding is already in base_value.
    const baselineIndex = data.base_value_asof ? -1 : equity.findIndex(value => isNumeric(value) && Number(value) !== 0);
    let netTransfers = 0;
    for (let index = 0; index < timestamps.length; index++) {
      // Count transfers even when an equity observation in that window is missing.
      if (index > baselineIndex) netTransfers += transfers[index];
      // New accounts and future slots may be null. Never turn these gaps into a fictitious total loss.
      if (![timestamps[index], equity[index], profitLoss[index]].every(isNumeric)) continue;
      const adjusted = result.baseValue === null ? Number(profitLoss[index])
        : index < baselineIndex ? 0 : Math.round((Number(equity[index]) - result.baseValue - netTransfers) * 100) / 100;
      result.timestamp.push(Number(timestamps[index]));
      result.equity.push(Number(equity[index]));
      result.profitLoss.push(adjusted);
      result.profitLossPct.push(result.baseValue !== null && result.baseValue > 0 ? adjusted / result.baseValue
        : result.baseValue === null ? nullableNumeric(profitLossPct[index]) : null);
    }
    return result;
  }

  async submitOrder(order: OrderRequest): Promise<Order> {
    const ticker = symbol(order.symbol);
    if (!Number.isFinite(order.qty) || order.qty <= 0 || order.qty > 1_000_000_000) throw new Error('Quantity must be a positive number.');
    if (order.side !== 'buy' && order.side !== 'sell') throw new Error('Choose buy or sell.');
    if (!['market', 'limit', 'stop'].includes(order.type)) throw new Error('Choose a market, limit or stop order.');
    const executionError = executionRulesError(order);
    if (executionError) throw new Error(executionError);
    if (order.clientOrderId && !/^[A-Za-z0-9_-]{1,128}$/.test(order.clientOrderId)) throw new Error('The order reference is invalid.');
    const body = {
      symbol: ticker, qty: String(order.qty), side: order.side, type: order.type, time_in_force: order.timeInForce ?? 'day', extended_hours: order.extendedHours === true,
      ...(order.type === 'limit' ? { limit_price: String(order.limitPrice) } : {}),
      ...(order.type === 'stop' ? { stop_price: String(order.stopPrice) } : {}),
      ...(order.stopLoss ? { order_class: 'oto', stop_loss: { stop_price: String(order.stopLoss.stopPrice) } } : {}),
      client_order_id: order.clientOrderId ?? `paca-${crypto.randomUUID()}`,
    };
    return this.mapSubmittedOrder(await this.request('/v2/orders', { method: 'POST', body }));
  }

  async getOrderByClientOrderId(clientOrderId: string): Promise<Order | null> {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(clientOrderId)) throw new Error('The order reference is invalid.');
    try {
      const order = mapOrder(await this.request(`/v2/orders:by_client_order_id?client_order_id=${encodeURIComponent(clientOrderId)}`));
      return order.orderClass === 'oto' ? this.getOrder(order.id) : order;
    } catch (error) {
      if (error instanceof AlpacaRequestError && error.status === 404) return null;
      throw error;
    }
  }

  async cancelOrder(id: string): Promise<void> {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error('The order ID is invalid.');
    await this.request(`/v2/orders/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }
}
