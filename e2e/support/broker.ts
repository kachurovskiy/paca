import { expect, type Page, type Route, type WebSocketRoute } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import type { Bar } from '../../src/core/types';
import { VaultCipher, type Sealed } from '../../src/core/vault';

export const PASSWORD = 'synthetic workspace password';
export async function unlock(page: Page) {
  await expect(page.getByLabel('Password', { exact: true })).toBeVisible();
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  if (await page.getByLabel('Confirm password', { exact: true }).count()) await page.getByLabel('Confirm password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: /^(Create password|Unlock)$/ }).click();
  await expect(page.getByLabel('Password', { exact: true })).toHaveCount(0);
}

export const OPEN = Date.parse('2026-09-17T13:30:00Z'), MINUTE = 60_000;
export const watchlistRequest = (url: URL, now: number) => /^\/v2\/stocks\/[^/]+\/bars$/.test(url.pathname)
  && url.searchParams.get('timeframe') === '5Min' && Math.abs(Date.parse(url.searchParams.get('start') ?? '') - (now - 14 * 24 * 60 * MINUTE)) < MINUTE;
export const DATES: string[] = [];
for (let i = 1; DATES.length < 20; i++) {
  const date = new Date(OPEN - i * 86_400_000), iso = date.toISOString().slice(0, 10);
  if (date.getUTCDay() !== 0 && date.getUTCDay() !== 6 && iso !== '2026-09-07') DATES.unshift(iso);
}
export function bar(open: number, index: number, live = false, step = 1) {
  return { t: new Date(open + index * MINUTE * step).toISOString(), o: 100 + index * .02 * step,
    c: 100 + (index + 1) * .02 * step, h: 100 + (index + 1) * .02 * step + .03, l: 100 + index * .02 * step - .03,
    v: (live ? 30_000 : 10_000) * step, vw: 100 + index * .02 * step + .01 };
}
type RawOrder = { id: string; symbol: string; side: string; qty: string; filled_qty: string; status: string;
  type: string; client_order_id: string; submitted_at: string; updated_at: string; limit_price?: string; filled_avg_price?: string; filled_at?: string;
  time_in_force?: string; order_class?: string; stop_price?: string; legs?: RawOrder[] };

/** Real browser fetch/WebSocket/IDB/Web Locks, with all remote traffic intercepted. */
export class BrokerFixture {
  now = OPEN + 60 * MINUTE + 6000;
  accountId = 'synthetic-browser-account';
  buyingPower = 100_000;
  equity = 100_000;
  cash = 50_000;
  bid = 101.19;
  ask = 101.21;
  tradePrice = 101.2;
  orders: RawOrder[] = [];
  positions: Record<string, unknown>[] = [];
  activities: Record<string, unknown>[] = [];
  requests: URL[] = [];
  socketUrls: string[] = [];
  writes: { origin: string; method: string; path: string; body: Record<string, unknown> | null }[] = [];
  errors: string[] = [];
  loseNextResponse = false;
  hideOrders = false;
  deferCancellation = false;
  badHistory = false;
  badResearch = false;
  shortResearch = false;
  sparseOvernightScanner = false;
  scannerNoBars = new Set<string>();
  watchlistBars: Record<string, Bar[]> = {};
  watchlistFailures = new Set<string>();
  quoteTimestamp?: string;
  delayChart: { symbol: string; release: (() => void) | null } | null = null;
  beforeWrite?: (route: Route) => Promise<void>;
  private sockets = new Map<Page, { socket: WebSocketRoute; subscriptions: Record<string, Set<string>> }>();
  private brokerOrders(): RawOrder[] {
    for (const parent of this.orders) for (const leg of parent.legs ?? []) {
      if (parent.status === 'filled' && leg.status === 'held') leg.status = 'new';
      if (parent.status === 'canceled' && leg.filled_qty === '0') leg.status = 'canceled';
    }
    return this.orders.flatMap(order => [order, ...(order.legs ?? [])]);
  }
  constructor(readonly paused = false, readonly runningClock = false) {}
  async install(page: Page, standalone = false, locked = false) {
    page.on('pageerror', error => this.errors.push(error.message));
    if (this.paused || this.runningClock) {
      await page.clock.install({ time: new Date(this.now) });
      if (this.paused) await page.clock.pauseAt(new Date(this.now));
    }
    else await page.clock.setFixedTime(new Date(this.now));
    await page.addInitScript(() => {
      const NativeObserver = window.ResizeObserver;
      Object.assign(window, { fixtureChartInstances: 0 });
      window.ResizeObserver = class extends NativeObserver {
        constructor(callback: ResizeObserverCallback) { super(callback); (window as unknown as { fixtureChartInstances: number }).fixtureChartInstances++; }
      };
    });
    await page.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url()), path = url.pathname, query = url.searchParams;
      if (url.origin === 'http://127.0.0.1:5173') {
        if (standalone && path === '/standalone.html') return route.fulfill({ contentType: 'text/html', body: await readFile('docs/index.html', 'utf8') });
        if (standalone && path !== '/favicon.ico') { this.errors.push(`Standalone requested a separate asset: ${path}`); return route.abort(); }
        return route.continue();
      }
      if (!['paper-api.alpaca.markets', 'api.alpaca.markets', 'data.alpaca.markets'].includes(url.hostname)) {
        this.errors.push(`Unexpected remote host: ${url.hostname}`); return route.abort();
      }
      this.requests.push(url);
      const method = request.method(), iso = new Date(this.now).toISOString();
      const json = (value: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
      if (method !== 'GET') {
        const body = method === 'POST' ? request.postDataJSON() : null;
        this.writes.push({ origin: url.origin, method, path, body });
        await this.beforeWrite?.(route);
        if (method === 'POST' && path === '/v2/orders') {
          const order: RawOrder = { ...body, id: `order-${this.orders.length + 1}`, order_class: body.order_class || 'simple', qty: String(body.qty), status: 'new', filled_qty: '0', submitted_at: iso, updated_at: iso };
          if (body.order_class === 'oto') order.legs = [{ id: `${order.id}-stop`, symbol: order.symbol, qty: order.qty, side: 'sell', type: 'stop',
            status: 'held', filled_qty: '0', submitted_at: iso, updated_at: iso, time_in_force: body.time_in_force, order_class: 'oto',
            client_order_id: `${order.id}-broker-stop`, stop_price: String(body.stop_loss.stop_price) }];
          this.orders.push(order);
          if (this.loseNextResponse) { this.loseNextResponse = false; return route.abort('failed'); }
          return json(order);
        }
        const order = this.brokerOrders().find(order => path === `/v2/orders/${order.id}`);
        if (method === 'DELETE' && order) {
          order.status = this.deferCancellation ? 'pending_cancel' : 'canceled'; order.updated_at = iso;
          if (!this.deferCancellation) for (const leg of order.legs ?? []) if (leg.filled_qty === '0') leg.status = 'canceled';
          return route.fulfill({ status: 204 });
        }
        this.errors.push(`Unexpected write: ${method} ${path}`); return route.abort();
      }
      if (path === '/v2/account') return json({ id: this.accountId, equity: String(this.equity), last_equity: String(this.equity), cash: String(this.cash), buying_power: String(this.buyingPower), regt_buying_power: String(this.buyingPower), portfolio_value: String(this.equity), daytrade_count: 0, status: 'ACTIVE', trading_blocked: false, created_at: '2026-01-02T14:30:00Z' });
      if (path === '/v2/clock') return json({ is_open: this.now >= OPEN && this.now < OPEN + 390 * MINUTE, timestamp: iso, next_open: new Date(OPEN + 86_400_000).toISOString(), next_close: new Date(OPEN + 390 * MINUTE).toISOString() });
      if (path === '/v2/calendar') return json([...DATES, this.sparseOvernightScanner ? '2026-09-21' : '2026-09-17'].filter(date => date >= (query.get('start') ?? '') && date <= (query.get('end') ?? '9999')).map(date => ({ date, open: '09:30', close: '16:00' })));
      if (path === '/v2/assets') return json(['STEADY', 'SPY', 'QQQ'].map(symbol => ({ id: `${symbol}-fixture`, symbol, name: `${symbol} fixture`, class: 'us_equity', exchange: 'NASDAQ', status: 'active', tradable: true, attributes: ['overnight_tradable'] })));
      if (path === '/v1beta1/screener/stocks/most-actives') return json({ last_updated: iso, most_actives: [] });
      if (path === '/v1beta1/screener/stocks/movers') return json({ last_updated: iso, gainers: [], losers: [] });
      if (path === '/v1/corporate-actions') return json({ corporate_actions: {}, next_page_token: null });
      if (path === '/v2/stocks/snapshots') return json(Object.fromEntries((query.get('symbols') ?? '').split(',').map(symbol => [symbol, { latestTrade: { p: this.tradePrice, t: this.quoteTimestamp ?? iso }, latestQuote: { bp: this.bid, ap: this.ask, bs: 10, as: 10, t: this.quoteTimestamp ?? iso }, prevDailyBar: { c: 110 }, dailyBar: { o: 100, h: 102, l: 99, c: 101.2, v: 3_900_000 } }])));
      if (path === '/v2/stocks/bars') {
        if (this.badResearch) return json({ message: 'Synthetic history unavailable' }, 403);
        const start = Date.parse(query.get('start')!), end = Date.parse(query.get('end')!), daily = query.get('timeframe') === '1Day', step = query.get('timeframe') === '5Min' ? 5 : 1;
        const currentDate = this.sparseOvernightScanner ? '2026-09-21' : '2026-09-17';
        const overnight = this.sparseOvernightScanner && query.get('feed') === 'boats';
        const rows = daily ? DATES.map(date => ({ ...bar(Date.parse(`${date}T13:30:00Z`), 0), v: 3_900_000 }))
          : [...DATES, currentDate].flatMap(date => Array.from({ length: (overnight ? 480 : 390) / step }, (_, i) => bar(Date.parse(`${date}T${overnight ? '00:00' : '13:30'}:00Z`), i, date === currentDate, step))
            .filter((_, i) => !overnight || i % 5 !== 1));
        const selected = rows.filter(row => Date.parse(row.t) >= start && Date.parse(row.t) <= end
          && !(this.shortResearch && step === 5 && Date.parse(row.t) < OPEN - 86_400_000));
        const offset = Number(query.get('page_token') || 0), limit = 3000;
        return json({ bars: Object.fromEntries((query.get('symbols') ?? '').split(',').map(symbol => [symbol, !daily && this.scannerNoBars.has(symbol) ? [] : selected.slice(offset, offset + limit)])), next_page_token: offset + limit < selected.length ? String(offset + limit) : null });
      }
      if (/^\/v2\/stocks\/[^/]+\/bars$/.test(path)) {
        const symbol = path.split('/')[3];
        const watchlist = watchlistRequest(url, this.now);
        if (watchlist && this.watchlistFailures.has(symbol)) return json({ message: 'History unavailable' }, 403);
        if (watchlist && this.watchlistBars[symbol]) return json({ bars: this.watchlistBars[symbol].filter(bar => Date.parse(bar.t) >= Date.parse(query.get('start')!)), next_page_token: null });
        if (!watchlist && this.delayChart?.symbol === symbol) await new Promise<void>(resolve => { this.delayChart!.release = resolve; });
        const price = symbol === 'QQQ' ? 222 : 111;
        return json({ bars: Array.from({ length: 12 }, (_, i) => ({ ...bar(OPEN, i, true, 5), o: price - .1, c: price, h: price + .1, l: price - .2 })), next_page_token: null });
      }
      if (path === '/v2/account/portfolio/history') return json({ timestamp: [Math.floor(OPEN / 1000), Math.floor(this.now / 1000)], equity: [100000, 100100], profit_loss: [0, 100], profit_loss_pct: [0, .001] });
      if (path === '/v2/positions') return json(this.positions);
      if (path === '/v2/orders') {
        const matching = this.hideOrders ? [] : this.brokerOrders()
          .filter(order => query.get('status') === 'all' || (query.get('status') === 'closed') === ['canceled', 'filled', 'rejected'].includes(order.status));
        return json(query.get('nested') === 'true'
          ? matching.filter(order => !matching.some(parent => parent.legs?.some(child => child.id === order.id)))
          : matching.map(({ legs: _legs, ...order }) => order));
      }
      if (path === '/v2/orders:by_client_order_id' || path.startsWith('/v2/orders/')) {
        const order = !this.hideOrders && this.brokerOrders().find(order => path.endsWith(`/${order.id}`) || query.get('client_order_id') === order.client_order_id);
        return order ? json(order) : json({ message: 'Order not found' }, 404);
      }
      if (path.startsWith('/v2/account/activities')) return this.badHistory ? json([{ activity_type: 'FILL', id: 'broken' }]) : json(path.endsWith('/FILL') ? this.activities : []);
      this.errors.push(`Unmocked endpoint: ${path}`); return route.abort();
    });
    await page.routeWebSocket('**/*', socket => {
      if (new URL(socket.url()).hostname === '127.0.0.1') { socket.onMessage(() => {}); socket.send(JSON.stringify({ type: 'connected' })); return; }
      if (new URL(socket.url()).hostname !== 'stream.data.alpaca.markets') { this.errors.push(`Unexpected socket: ${socket.url()}`); socket.close(); return; }
      this.socketUrls.push(socket.url());
      const subscriptions = Object.fromEntries(['trades', 'quotes', 'bars', 'updatedBars', 'statuses'].map(key => [key, new Set<string>()]));
      this.sockets.set(page, { socket, subscriptions });
      socket.onMessage(message => {
        const frame = JSON.parse(String(message));
        if (frame.action === 'auth') { socket.send(JSON.stringify([{ T: 'success', msg: 'authenticated' }])); return; }
        for (const key of Object.keys(subscriptions)) for (const symbol of frame[key] || []) {
          if (frame.action === 'subscribe') subscriptions[key].add(symbol); else subscriptions[key].delete(symbol);
        }
        socket.send(JSON.stringify([{ T: 'subscription', ...Object.fromEntries(Object.entries(subscriptions).map(([key, values]) => [key, [...values]])) }]));
        this.quote(page);
      });
      socket.send(JSON.stringify([{ T: 'success', msg: 'connected' }]));
    });
    await page.goto(standalone ? '/standalone.html' : '/');
    if (!locked) await unlock(page);
  }
  async connect(page: Page, environment = 'paper') {
    await page.getByRole('button', { name: 'Connect Alpaca', exact: true }).click();
    await expect(page.getByRole('dialog')).toContainText('Real-time SIP market data is required.');
    await expect(page.getByRole('combobox', { name: 'Market data feed' })).toHaveCount(0);
    await page.getByLabel('API key', { exact: true }).fill('synthetic-key');
    await page.getByLabel('Secret key', { exact: true }).fill('synthetic-secret');
    await page.getByRole('group', { name: 'Environment' }).getByRole('button', { name: environment === 'live' ? 'Live' : 'Paper', exact: true }).click();
    await page.getByRole('button', { name: 'Connect account', exact: true }).last().click();
  }
  quote(page: Page) {
    const connection = this.sockets.get(page); if (!connection) return;
    const open = this.sparseOvernightScanner ? Date.parse('2026-09-21T00:00:00Z') : OPEN;
    const iso = this.quoteTimestamp ?? new Date(this.now).toISOString(), index = Math.floor((this.now - open) / MINUTE) - 1;
    const frames = [
      ...[...connection.subscriptions.quotes].map(symbol => ({ T: 'q', S: symbol, bp: this.bid, ap: this.ask, bs: 10, as: 10, t: iso })),
      ...[...connection.subscriptions.trades].map(symbol => ({ T: 't', S: symbol, p: this.tradePrice, s: 100, t: iso })),
      ...[...connection.subscriptions.bars].filter(symbol => !this.scannerNoBars.has(symbol) && (!this.sparseOvernightScanner || index % 5 !== 1))
        .map(symbol => ({ T: 'b', S: symbol, ...bar(open, index, true) })),
    ];
    if (frames.length) connection.socket.send(JSON.stringify(frames));
  }
  async advance(page: Page, ms: number) {
    this.now += ms;
    if (this.paused) await page.clock.runFor(ms); else await page.clock.setFixedTime(new Date(this.now));
    this.quote(page);
    // Native mocked fetch and socket delivery need a task turn after virtual timers.
    await page.waitForTimeout(10);
  }
  async ready(page: Page, environment = 'paper') { await expect(page.locator('.mode-badge')).toHaveText(environment === 'live' ? 'Live' : 'Paper'); await expect(page.locator('.stats-grid')).toContainText('ready'); }
  async connected(page: Page) { await this.connect(page); await this.ready(page); }
}

interface RawRecord extends Sealed { key: string; scope: string; active: string }
export async function rawStored(page: Page, store: string): Promise<RawRecord[]> {
  return page.evaluate(store => new Promise((resolve, reject) => {
    const header = JSON.parse(localStorage.getItem('paca.vault.1')!);
    const request = indexedDB.open(`paca-vault-1-${header.salt}`, 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => { const db = request.result, tx = db.transaction(store), read = tx.objectStore(store).getAll();
      read.onsuccess = () => resolve(read.result); tx.oncomplete = () => db.close(); tx.onerror = () => reject(tx.error); };
  }), store);
}
async function encryption(page: Page) {
  const salt = await page.evaluate(() => JSON.parse(localStorage.getItem('paca.vault.1')!).salt as string);
  return { cipher: await VaultCipher.derive(PASSWORD, Uint8Array.from(Buffer.from(salt, 'base64'))), name: `paca-vault-1-${salt}` };
}
export async function stored(page: Page, store: string): Promise<Record<string, unknown>[]> {
  const { cipher, name } = await encryption(page);
  return Promise.all((await rawStored(page, store)).map(row => cipher.open(row, JSON.stringify([name, store, row.key, row.scope, row.active])) as Promise<Record<string, unknown>>));
}
export async function saveStored(page: Page, store: string, value: Record<string, unknown>) {
  const { cipher, name } = await encryption(page), scope = JSON.parse(value.key as string)[0];
  const row = { key: `${await cipher.index([store, 'scope', scope])}:${await cipher.index([store, 'key', value.key])}`,
    scope: await cipher.index([store, 'scope', value.scope]), active: await cipher.index([store, 'active', [value.scope, value.active ?? null]]) };
  await saveRaw(page, store, { ...row, ...await cipher.seal(value, JSON.stringify([name, store, row.key, row.scope, row.active])) });
}
export async function saveRaw(page: Page, store: string, row: RawRecord) {
  await page.evaluate(({ store, row }) => new Promise<void>((resolve, reject) => {
    const header = JSON.parse(localStorage.getItem('paca.vault.1')!), request = indexedDB.open(`paca-vault-1-${header.salt}`, 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => { const db = request.result, tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).put(row); tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => reject(tx.error); };
  }), { store, row });
}
