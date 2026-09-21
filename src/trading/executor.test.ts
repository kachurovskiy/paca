import { calendarTimeToUtc, fullTradingSession, FULL_SESSION_CALENDAR, tradingDate } from '../core/exchange-session';
import { isOvernightTime } from '../core/trading-session';
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDatabase, type Database } from '../core/database';
import { BrokerWriteError, type AccountReads, type BrokerMutations } from '../broker/capabilities';
import { inputFixture, NOW } from '../robots/templates/test-fixtures';
import { opportunityKey } from '../robots/validation';
import type { Account, Order, OrderRequest, Position, TradeActivity } from '../core/types';
import { Trading } from './executor';
import { manualReviewKey, ManualReviewRequired, previewManual } from './manual-order';
import { capitalAvailable } from './capital';
import { AccountOwnership } from './ownership';
import { accountKey } from '../core/account';
import { ExecutionStore } from './storage';
import type { ExecutionMarket } from './market';
import type { ExecutionQuote } from '../core/quote';
import type { ExecutionStorage } from './records';
import { ownedInventory } from './facts';
import { ResearchDocuments } from '../robots/documents';
import { protectionStatus } from './protection';
import { wickCapture } from '../robots/templates/wick-capture';
import type { StrategyTemplate } from '../robots/templates/types';

function fakeLocks(): LockManager {
  const held = new Set<string>();
  return { request: async (name: string, options: LockOptions | LockGrantedCallback, supplied?: LockGrantedCallback) => {
    const callback = typeof options === 'function' ? options : supplied!;
    if (held.has(name)) return callback(null);
    held.add(name);
    try { return await callback({ name, mode: 'exclusive' }); }
    finally { held.delete(name); }
  }, query: async () => ({ held: [], pending: [] }) };
}
const pending = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};
const databases: Database[] = [], sessions: Trading[] = [];
afterEach(async () => { await Promise.all(sessions.splice(0).map(session => session.dispose())); databases.splice(0).forEach(db => db.close()); });

async function setup(options: { environment?: 'paper' | 'live'; template?: StrategyTemplate; store?: (store: ExecutionStore) => ExecutionStorage } = {}) {
  const input = inputFixture(options.template); input.approved.plan.scope.broker = 'alpaca'; input.approved.scope.broker = 'alpaca';
  input.approved.plan.scope.environment = input.approved.scope.environment = options.environment ?? 'paper';
  input.approved.plan.opportunityKey = opportunityKey(input.approved.plan);
  const scope = input.approved.scope, plan = input.approved.plan;
  let time = NOW;
  const db = await openDatabase(`test-${crypto.randomUUID()}`); databases.push(db);
  const stored = new ExecutionStore(db), storage = options.store?.(stored) ?? stored;
  const locks = fakeLocks();
  const orders = new Map<string, Order>(), activities: TradeActivity[] = [];
  const brokerOrders = () => {
    for (const parent of orders.values()) for (const leg of parent.legs ?? []) {
      if (parent.status === 'filled' && leg.status === 'held') leg.status = 'new';
      if (parent.status === 'canceled' && leg.filledQty === 0) leg.status = 'canceled';
    }
    return [...orders.values()].flatMap(order => [order, ...(order.legs ?? [])]);
  };
  let positions: Position[] = [];
  const account: Account = { id: scope.accountId, equity: 10_000, buyingPower: 10_000, cash: 10_000, lastEquity: 10_000,
    portfolioValue: 10_000, daytradeCount: 0, tradingBlocked: false, createdAt: null };
  const quote: ExecutionQuote = { symbol: plan.symbol, price: 106, bid: 106, ask: 106, tradeAt: NOW, quoteAt: NOW, receivedAt: NOW, feed: 'sip' };
  const reads: AccountReads = {
    getAccount: vi.fn(async () => ({ ...account })), getPositions: vi.fn(async () => structuredClone(positions)),
    getOrders: vi.fn(async () => structuredClone(brokerOrders())),
    getOrder: vi.fn(async id => { const order = brokerOrders().find(order => order.id === id); if (!order) throw new Error('Not found'); return structuredClone(order); }),
    getOrderByClientOrderId: vi.fn(async id => structuredClone(brokerOrders().find(order => order.clientOrderId === id) ?? null)),
    getTradeActivities: vi.fn(async () => ({ activities: structuredClone(activities), nextPageToken: null })),
    getClock: vi.fn(async () => ({ isOpen: true, timestamp: new Date(time).toISOString(), nextOpen: plan.session.openAt, nextClose: plan.session.closeAt })),
  };
  const accept = (request: OrderRequest): Order => {
    const order: Order = { id: `order-${orders.size}`, clientOrderId: request.clientOrderId, symbol: request.symbol,
      side: request.side, qty: request.qty, filledQty: 0, type: request.type, status: 'new', submittedAt: new Date(time).toISOString(),
      timeInForce: request.timeInForce ?? 'day', limitPrice: request.limitPrice, stopPrice: request.stopPrice, orderClass: 'simple', extendedHours: request.extendedHours === true };
    if (request.stopLoss) {
      order.orderClass = 'oto';
      order.legs = [{ id: `${order.id}-stop`, parentOrderId: order.id, clientOrderId: `${order.id}-broker-stop`, symbol: order.symbol,
        side: 'sell', qty: request.qty, filledQty: 0, type: 'stop', status: 'held', submittedAt: order.submittedAt,
        timeInForce: request.timeInForce ?? 'day', stopPrice: request.stopLoss.stopPrice }];
    }
    orders.set(order.id, order); return structuredClone(order);
  };
  const writes: BrokerMutations = { submitOrder: vi.fn(async request => accept(request)), cancelOrder: vi.fn(async () => {}) };
  const market: ExecutionMarket = { quote: () => quote, ready: () => true, snapshot: vi.fn(async () => structuredClone(input.market)) };
  const make = async () => {
    const owner = await AccountOwnership.acquire(scope, locks);
    const trading = new Trading(owner, reads, writes, market, storage, () => time); sessions.push(trading);
    await trading.initialize(); return trading;
  };
  const trading = await make();
  return { trading, make, db, stored, storage, writes, reads, market, input, plan, scope, locks, orders, activities, quote, account, accept,
    time: (next: number) => { time = next; }, positions: (next: Position[]) => { positions = next; } };
}
const ticket = { symbol: 'TEST', side: 'buy', type: 'market', quantity: 1, timeInForce: 'day', extendedHours: false } as const;

describe('manual stop execution', () => {
  it.each(['day', 'gtc'] as const)('keeps a %s attached stop tracked after the entry fills and after reopening', async timeInForce => {
    const h = await setup();
    await h.trading.submitManual('protected', { ...ticket, quantity: 2, stopLossPrice: 100, timeInForce });
    expect(h.writes.submitOrder).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ stopLoss: { stopPrice: 100 }, timeInForce }));
    const parent = [...h.orders.values()][0];
    expect(h.trading.model.manual[0].order?.legs).toHaveLength(1);
    fillEntry(h, 2);
    await h.trading.reconcile();
    expect(h.trading.model.manual[0]).toMatchObject({ status: 'acknowledged', commitmentCents: 0, order: { status: 'filled', legs: [{ status: 'new' }] } });
    expect(h.trading.model.observation?.orders.find(order => order.id === parent.legs![0].id)).toMatchObject({ side: 'sell', type: 'stop', timeInForce });
    await h.trading.dispose(); const reopened = await h.make();
    expect(reopened.model.hold).toBeNull();
    Object.assign(parent.legs![0], { status: 'filled', filledQty: 2 });
    h.positions([]); await reopened.reconcile();
    expect(reopened.model.manual[0]).toMatchObject({ status: 'resolved', commitmentCents: 0, order: { legs: [{ status: 'filled' }] } });
    expect(h.writes.submitOrder).toHaveBeenCalledTimes(1);
  });

  it('retains an uncertain protected buy when the stop is missing and recovers without another write', async () => {
    const h = await setup();
    vi.mocked(h.writes.submitOrder).mockImplementation(async request => ({ ...h.accept(request), legs: [] }));
    expect((await h.trading.submitManual('missing-stop', { ...ticket, stopLossPrice: 100 })).status).toBe('uncertain');
    expect(h.trading.model.manual[0].commitmentCents).toBeGreaterThan(0);
    await h.trading.reconcile();
    expect(h.trading.model.manual[0]).toMatchObject({ status: 'acknowledged', order: { legs: [{ stopPrice: 100 }] } });
    expect(h.writes.submitOrder).toHaveBeenCalledTimes(1);
  });

  it.each(['day', 'gtc'] as const)('persists and reconciles a standalone %s sell stop', async timeInForce => {
    const h = await setup();
    h.positions([{ symbol: 'TEST', qty: 4, side: 'long', avgEntryPrice: 90, currentPrice: 106, marketValue: 424, unrealizedPl: 64, unrealizedPlpc: .17 }]);
    const command = await h.trading.submitManual('sell-stop', { ...ticket, side: 'sell', type: 'stop', stopPrice: 100, quantity: 2, timeInForce });
    expect(command).toMatchObject({ status: 'acknowledged', commitmentCents: 0, action: { request: { type: 'stop', stopPrice: 100, timeInForce } } });
    await h.trading.dispose(); const reopened = await h.make(); expect(reopened.model.hold).toBeNull();
    Object.assign(h.orders.get(command.brokerOrderId!)!, { status: 'filled', filledQty: 2 });
    await reopened.reconcile(); expect(reopened.model.manual[0].status).toBe('resolved');
    expect(h.writes.submitOrder).toHaveBeenCalledTimes(1);
  });

  it('rejects a mismatched standalone stop acknowledgement and does not mark it accepted', async () => {
    const h = await setup();
    h.positions([{ symbol: 'TEST', qty: 4, side: 'long', avgEntryPrice: 90, currentPrice: 106, marketValue: 424, unrealizedPl: 64, unrealizedPlpc: .17 }]);
    vi.mocked(h.writes.submitOrder).mockImplementation(async request => ({ ...h.accept(request), stopPrice: 99 }));
    expect((await h.trading.submitManual('stop-mismatch', { ...ticket, side: 'sell', type: 'stop', stopPrice: 100 })).status).toBe('uncertain');
    expect(h.writes.submitOrder).toHaveBeenCalledTimes(1);
  });

  it('validates stop increments, market price, and fresh evidence before an intent is saved', async () => {
    const h = await setup();
    await expect(h.trading.submitManual('tick', { ...ticket, stopLossPrice: 100.001 })).rejects.toThrow('increments');
    await expect(h.trading.submitManual('above', { ...ticket, stopLossPrice: 106 })).rejects.toThrow('below the current market');
    h.quote.tradeAt = NOW - 91_000;
    await expect(h.trading.submitManual('stale', { ...ticket, type: 'limit', limitPrice: 106, stopLossPrice: 100 })).rejects.toThrow('fresh market price');
    expect(h.trading.model.manual).toHaveLength(0); expect(h.writes.submitOrder).not.toHaveBeenCalled();
  });
});

describe('explicit manual execution and review', () => {
  it('persists exactly the selected duration and sessions for a manual limit', async () => {
    const h = await setup();
    await h.trading.submitManual('explicit', { ...ticket, type: 'limit', limitPrice: 106, timeInForce: 'gtc', extendedHours: false });
    expect(h.writes.submitOrder).toHaveBeenCalledWith(expect.objectContaining({ timeInForce: 'gtc', extendedHours: false, limitPrice: 106 }));
    expect((await h.stored.getManualCommands(h.trading.scope))[0].action).toMatchObject({ request: { timeInForce: 'gtc', extendedHours: false } });
  });

  it('blocks regular-only limits outside regular hours until extended hours are explicitly chosen', async () => {
    const h = await setup();
    vi.mocked(h.reads.getClock).mockResolvedValue({ isOpen: false, timestamp: new Date(NOW).toISOString(), nextOpen: h.plan.session.openAt, nextClose: h.plan.session.closeAt });
    const draft = { ...ticket, type: 'limit' as const, limitPrice: 106 };
    await expect(h.trading.submitManual('regular', draft)).rejects.toThrow('selected trading session');
    expect(h.writes.submitOrder).not.toHaveBeenCalled();
    await h.trading.submitManual('extended', { ...draft, extendedHours: true });
    expect(h.writes.submitOrder).toHaveBeenCalledWith(expect.objectContaining({ timeInForce: 'day', extendedHours: true }));
  });

  it('rejects invalid increments before recording an intent or calling the broker', async () => {
    const h = await setup();
    await expect(h.trading.submitManual('bad-tick', { ...ticket, type: 'limit', limitPrice: 1.001 })).rejects.toThrow('$0.01');
    expect(h.trading.model.manual).toHaveLength(0); expect(h.writes.submitOrder).not.toHaveBeenCalled();
  });

  it('deducts robot and manual reservations from extended-session capital for both preview and sizing', async () => {
    const h = await setup();
    await h.trading.approve('robot', h.plan);
    h.account.regtBuyingPower = 9900;
    await h.trading.submitManual('manual-reservation', { ...ticket, symbol: 'OTHER', quantity: 1 });
    const capital = capitalAvailable(h.account, h.trading.model.runs, h.trading.model.manual, true);
    expect(capital.reservedCents).toBe(h.plan.capital.ceilingCents + 10600);
    expect(capital.availableCents).toBe(990000 - capital.reservedCents);
    const draft = { ...ticket, symbol: 'THIRD', type: 'limit' as const, quantity: Math.floor(capital.availableCents / 10600), limitPrice: 106, extendedHours: true };
    const preview = previewManual(draft, h.account, undefined, h.quote, capital.availableCents / 100, 'paper');
    await h.trading.submitManual('sized', draft, { key: manualReviewKey(preview), confirmed: false });
    expect(h.writes.submitOrder).toHaveBeenLastCalledWith(expect.objectContaining({ qty: preview.request.qty, limitPrice: 106, extendedHours: true }));
  });

  it('requires a bound confirmation for a full close and rechecks changed holdings', async () => {
    const h = await setup();
    const position: Position = { symbol: 'TEST', qty: 2, side: 'long', avgEntryPrice: 100, currentPrice: 106, marketValue: null, unrealizedPl: null, unrealizedPlpc: null };
    h.positions([position]);
    const draft = { ...ticket, side: 'sell' as const, type: 'limit' as const, quantity: position.qty, limitPrice: 106 };
    const review = await h.trading.submitManual('close', draft).catch(error => error) as ManualReviewRequired;
    expect(review).toBeInstanceOf(ManualReviewRequired); expect(review.preview.positionAfter).toBe(0);
    expect(h.writes.submitOrder).not.toHaveBeenCalled(); expect(h.trading.model.manual).toHaveLength(0);
    h.positions([{ ...position, qty: 2.5 }]);
    const changed = await h.trading.submitManual('close', draft, { key: manualReviewKey(review.preview), confirmed: true }).catch(error => error) as ManualReviewRequired;
    expect(changed).toBeInstanceOf(ManualReviewRequired); expect(changed.preview.request.qty).toBe(position.qty);
    expect(changed.preview.positionAfter).toBeCloseTo(2.5 - position.qty);
    expect(h.writes.submitOrder).not.toHaveBeenCalled();
    await h.trading.submitManual('close', draft, { key: manualReviewKey(changed.preview), confirmed: true });
    expect(h.writes.submitOrder).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ qty: position.qty, side: 'sell', timeInForce: 'day', extendedHours: false }));
  });

  it.each([['absolute', 100_000, 100], ['relative', 10_000, 24]] as const)('confirms the %s large-live threshold but lets small orders through', async (_kind, equity, quantity) => {
    const h = await setup({ environment: 'live' });
    h.account.equity = h.account.buyingPower = equity;
    await h.trading.armLive(true);
    const draft = { ...ticket, quantity };
    const review = await h.trading.submitManual('large', draft).catch(error => error) as ManualReviewRequired;
    expect(review).toBeInstanceOf(ManualReviewRequired); expect(h.writes.submitOrder).not.toHaveBeenCalled();
    await h.trading.submitManual('large', draft, { key: manualReviewKey(review.preview), confirmed: true });
    await h.trading.submitManual('small', { ...ticket, symbol: 'OTHER' });
    expect(h.writes.submitOrder).toHaveBeenCalledTimes(2);
  });

  it('preserves the entered limit when the quote changes after the displayed preview', async () => {
    const h = await setup(), draft = { ...ticket, type: 'limit' as const, limitPrice: 106 };
    const preview = previewManual(draft, h.account, undefined, h.quote, 10_000, 'paper');
    h.quote.ask = 107;
    await h.trading.submitManual('limit', draft, { key: manualReviewKey(preview), confirmed: false });
    expect(h.writes.submitOrder).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ qty: 1, limitPrice: 106 }));
  });

  it('rechecks large-order thresholds against refreshed market prices', async () => {
    const h = await setup({ environment: 'live' }), draft = { ...ticket, quantity: 23 };
    await h.trading.armLive(true);
    const preview = previewManual(draft, h.account, undefined, h.quote, 10_000, 'live');
    expect(preview.confirmationReasons).toHaveLength(0);
    h.quote.price = 110;
    const changed = await h.trading.submitManual('threshold', draft, { key: manualReviewKey(preview), confirmed: false }).catch(error => error) as ManualReviewRequired;
    expect(changed).toBeInstanceOf(ManualReviewRequired); expect(changed.preview.confirmationReasons.join()).toContain('25%');
    expect(h.writes.submitOrder).not.toHaveBeenCalled();
    // Market prices can move within the already reviewed consequence without a repeated dialog.
    h.quote.price = 111;
    await h.trading.submitManual('threshold', draft, { key: manualReviewKey(changed.preview), confirmed: true });
    expect(h.writes.submitOrder).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ type: 'market', qty: 23 }));
  });
});
function fillEntry(h: Awaited<ReturnType<typeof setup>>, qty?: number) {
  const order = [...h.orders.values()][0]; qty ??= order.qty!;
  Object.assign(order, { filledQty: qty, status: qty === order.qty ? 'filled' : 'partially_filled', filledAvgPrice: 106 });
  h.activities.push({ id: 'entry-fill', orderId: order.id, symbol: 'TEST', side: 'buy', qty, price: 106, transactionTime: new Date(NOW).toISOString(), type: 'fill' });
  h.positions([{ symbol: 'TEST', qty, side: 'long', avgEntryPrice: 106, currentPrice: 106, marketValue: qty * 106, unrealizedPl: 0, unrealizedPlpc: 0 }]);
  return order;
}

describe('broker timestamps in robot decisions', () => {
  it.each(['2026-09-18T13:59:59Z', '2026-09-18T13:59:59.123456Z',
    '2026-09-18T13:59:59.123456789Z', '2026-09-18T09:59:59.123456-04:00'])(
    'supervises and recovers an existing entry with broker timestamp %s without resubmitting', async submittedAt => {
      const h = await setup({ template: wickCapture });
      await h.trading.approve('robot', h.plan); await h.trading.tick();
      const entry = [...h.orders.values()][0]; entry.submittedAt = submittedAt;
      await h.trading.tick();
      expect(h.trading.model.runs[0].latestDecision?.reasonCode).toBe('resting_bid');
      expect(h.trading.model.runs[0].orders.find(order => order.id === entry.id)?.submittedAt).toBe(submittedAt);
      await h.trading.dispose(); const reopened = await h.make();
      await reopened.resume('run-robot'); await reopened.tick();
      expect(reopened.model.runs[0].latestDecision?.reasonCode).toBe('resting_bid');
      expect(h.writes.submitOrder).toHaveBeenCalledOnce(); expect(h.writes.cancelOrder).not.toHaveBeenCalled();
    });

  it.each([false, true])('anchors the holding clock to a precise broker fill (partial: %s) and recovers saved state', async partial => {
    const h = await setup({ template: wickCapture });
    await h.trading.approve('robot', h.plan); await h.trading.tick();
    const entry = fillEntry(h, partial ? 1 : undefined), transactionTime = '2026-09-18T13:59:59.123456789Z';
    h.activities[0].transactionTime = transactionTime;
    await h.trading.tick();
    const run = h.trading.model.runs[0];
    expect(run.latestDecision?.reasonCode).toBe(partial ? 'cancel_entry' : 'holding_fill');
    expect(run.strategy.firstFillAt).toBe('2026-09-18T13:59:59.123Z');
    expect(run.fills[0].transactionTime).toBe(transactionTime);
    if (partial) entry.status = 'canceled';
    // Previous builds could persist the raw broker time in strategy state.
    await h.trading.dispose(); await h.stored.saveRun({ ...run, strategy: { ...run.strategy, firstFillAt: transactionTime } });
    const reopened = await h.make(); await reopened.resume('run-robot'); await reopened.tick(); await reopened.tick();
    const recovered = reopened.model.runs[0];
    expect(recovered.latestDecision?.reasonCode).toBe('holding_fill');
    expect(recovered.strategy.firstFillAt).toBe('2026-09-18T13:59:59.123Z');
    expect(recovered.latestDecision?.conditions.find(condition => condition.code === 'holding_deadline')?.threshold)
      .toBe(Date.parse(transactionTime) + h.plan.parameters.holdMinutes * 60_000);
    expect(recovered.fills[0].transactionTime).toBe(transactionTime);
    expect(h.writes.submitOrder).toHaveBeenCalledTimes(partial ? 2 : 1); // A canceled partial entry needs its own backup stop.
    expect(h.writes.cancelOrder).toHaveBeenCalledTimes(partial ? 1 : 0);
  });
});

describe('automatic account reconciliation', () => {
  it('refreshes idle account displays four times a minute while explicit reads stay immediate', async () => {
    const h = await setup(); await h.trading.reconcile();
    for (const read of [h.reads.getAccount, h.reads.getOrders, h.reads.getPositions, h.reads.getClock]) vi.mocked(read).mockClear();
    for (let elapsed = 5000; elapsed <= 60_000; elapsed += 5000) { h.time(NOW + elapsed); await h.trading.tick(); }
    for (const read of [h.reads.getAccount, h.reads.getOrders, h.reads.getPositions, h.reads.getClock]) expect(read).toHaveBeenCalledTimes(4);
    await h.trading.reconcile(); expect(h.reads.getAccount).toHaveBeenCalledTimes(5);
    h.quote.tradeAt = h.quote.quoteAt = h.quote.receivedAt = NOW + 60_000;
    await h.trading.submitManual('fresh-write', ticket);
    expect(h.reads.getAccount).toHaveBeenCalledTimes(6); expect(h.writes.submitOrder).toHaveBeenCalledOnce();
  });
  it('retries failed idle reads on the next cycle and refreshes after a backward clock change', async () => {
    const h = await setup(); await h.trading.tick();
    h.time(NOW + 15_000); vi.mocked(h.reads.getAccount).mockRejectedValueOnce(new Error('offline'));
    await expect(h.trading.tick()).rejects.toThrow('offline');
    h.time(NOW + 20_000); await h.trading.tick();
    expect(h.trading.model.reconciliationError).toBeNull();
    h.time(NOW); await h.trading.tick(); expect(h.reads.getAccount).toHaveBeenCalledTimes(4);
  });
  it('shares the account order batch for manual orders and still observes fills every five seconds', async () => {
    const h = await setup(); await h.trading.submitManual('resting', { ...ticket, type: 'limit', limitPrice: 106, quantity: 10 });
    for (const read of [h.reads.getAccount, h.reads.getOrders, h.reads.getOrder]) vi.mocked(read).mockClear();
    for (let elapsed = 5000; elapsed <= 60_000; elapsed += 5000) { h.time(NOW + elapsed); await h.trading.tick(); }
    expect(h.reads.getOrders).toHaveBeenCalledTimes(12); expect(h.reads.getAccount).toHaveBeenCalledTimes(12);
    expect(h.reads.getOrder).not.toHaveBeenCalled();
    fillEntry(h, 4); h.time(NOW + 65_000); await h.trading.tick();
    expect(h.trading.model.manual[0]).toMatchObject({ commitmentCents: 63600, order: { filledQty: 4 } });
  });
  it('keeps observing external working orders every five seconds', async () => {
    const h = await setup(); h.accept({ symbol: 'OTHER', side: 'buy', type: 'limit', qty: 1, limitPrice: 10 });
    await h.trading.reconcile(); h.time(NOW + 5000); await h.trading.tick();
    expect(h.reads.getAccount).toHaveBeenCalledTimes(2);
  });
  it.each(['regular', 'overnight'])('supervises twenty resting %s robots with one account batch and no per-order reads', async mode => {
    const h = await setup({ template: wickCapture });
    if (mode === 'overnight') prepare24(h, Date.parse('2026-09-21T02:00:00Z'));
    h.account.cash = h.account.buyingPower = h.account.equity = 100_000;
    vi.mocked(h.market.snapshot).mockImplementation(async plan => ({ ...structuredClone(h.input.market), symbol: plan.symbol }));
    for (let index = 0; index < 20; index++) {
      const plan = { ...h.plan, id: `proposal-${index}`, symbol: `TEST${index}` }; plan.opportunityKey = opportunityKey(plan);
      await h.trading.approve(`robot-${index}`, plan);
    }
    await h.trading.tick(); expect(h.writes.submitOrder).toHaveBeenCalledTimes(20);
    for (const read of [h.reads.getAccount, h.reads.getOrders, h.reads.getPositions, h.reads.getClock, h.reads.getOrder, h.reads.getOrderByClientOrderId]) vi.mocked(read).mockClear();
    await h.trading.tick();
    for (const read of [h.reads.getAccount, h.reads.getOrders, h.reads.getPositions, h.reads.getClock]) expect(read).toHaveBeenCalledOnce();
    expect(h.reads.getOrder).not.toHaveBeenCalled(); expect(h.reads.getOrderByClientOrderId).not.toHaveBeenCalled();
    expect(h.writes.submitOrder).toHaveBeenCalledTimes(20);
    expect(h.writes.cancelOrder).not.toHaveBeenCalled();
    expect(h.trading.model.runs.every(run => run.state === 'running' && !run.blocked)).toBe(true);
  });
  it('reads missing attached legs once and still finds fills omitted from the account order list', async () => {
    const h = await setup(); await h.trading.approve('robot', h.plan); await h.trading.tick();
    vi.mocked(h.reads.getOrders).mockImplementation(async () => [...h.orders.values()].map(({ legs: _legs, ...order }) => structuredClone(order)));
    vi.mocked(h.reads.getOrder).mockClear(); await h.trading.reconcile();
    expect(h.reads.getOrder).toHaveBeenCalledOnce();
    expect(h.trading.model.runs[0].orders).toHaveLength(2);
    const entry = fillEntry(h);
    vi.mocked(h.reads.getOrders).mockResolvedValue([]); vi.mocked(h.reads.getOrder).mockClear();
    await h.trading.reconcile();
    expect(h.reads.getOrder).toHaveBeenCalledOnce();
    expect(ownedInventory(h.trading.model.runs[0]).quantity).toBe(entry.qty);
    expect(h.trading.model.runs[0].blocked).toBeNull();
  });
  it.each([false, true])('reuses batched OTO stop evidence after the parent resolves (flat open child: %s)', async flat => {
    const h = await setup({ template: wickCapture });
    await h.trading.approve('robot', h.plan); await h.trading.tick();
    const entry = fillEntry(h), stop = entry.legs![0]; stop.orderClass = 'oto';
    await h.trading.tick();
    if (flat) vi.mocked(h.reads.getOrders).mockImplementation(async () => structuredClone([
      { ...stop, parentOrderId: undefined }, entry,
    ]));
    vi.mocked(h.reads.getOrder).mockClear(); await h.trading.tick();
    expect(h.reads.getOrder).not.toHaveBeenCalled();
    expect(h.trading.model.runs[0].latestDecision?.reasonCode).toBe('holding_fill');
    expect(protectionStatus(h.trading.model.runs[0]).state).toBe('active');
    Object.assign(stop, { status: 'filled', filledQty: stop.qty }); h.positions([]);
    h.activities.push({ id: 'stop-fill', orderId: stop.id, symbol: stop.symbol, side: 'sell', qty: stop.qty!, price: 104,
      transactionTime: new Date(NOW).toISOString(), type: 'fill' });
    await h.trading.reconcile();
    expect(ownedInventory(h.trading.model.runs[0]).quantity).toBe(0);
    expect(h.trading.model.runs[0].blocked).toBeNull(); expect(h.reads.getOrder).not.toHaveBeenCalled();
    expect(h.writes.submitOrder).toHaveBeenCalledOnce();
  });

  it('follows manual partial fills, completion and cancellation and releases capital for the next order', async () => {
    const h = await setup();
    await h.trading.submitManual('limit', { ...ticket, type: 'limit', limitPrice: 106, quantity: 80 });
    const order = fillEntry(h, 40);
    await h.trading.tick();
    expect(h.trading.model.manual[0]).toMatchObject({ status: 'acknowledged', commitmentCents: 424000,
      order: { status: 'partially_filled', filledQty: 40 } });
    expect(h.trading.model.observation?.positions[0].qty).toBe(40);
    expect(h.trading.model.observation?.orders[0].filledQty).toBe(40);

    fillEntry(h, 80); h.account.buyingPower = 1000;
    // Terminal orders need direct lookups even if the broker list no longer includes them.
    vi.mocked(h.reads.getOrders).mockResolvedValue([]);
    await h.trading.tick();
    expect(h.trading.model.manual[0]).toMatchObject({ status: 'resolved', commitmentCents: 0, order: { status: 'filled' } });
    expect(h.trading.model.observation?.positions[0].qty).toBe(80);
    expect(h.trading.model.observation?.orders[0].status).toBe('filled');
    const next = await h.trading.submitManual('cancel-me', { ...ticket, type: 'limit', limitPrice: 106, quantity: 8 });
    await h.trading.cancelManual('cancel', next.brokerOrderId!);
    await h.trading.tick();
    expect(h.trading.model.manual[2].status).toBe('acknowledged');
    expect(h.trading.allocationSnapshot().uncertain).toBe(true);
    await expect(h.trading.submitManual('too-soon', { ...ticket, symbol: 'OTHER' })).rejects.toThrow('uncertain');
    h.orders.get(next.brokerOrderId!)!.status = 'canceled';
    await h.trading.tick();
    expect(h.trading.model.manual.slice(1)).toMatchObject([{ status: 'resolved', commitmentCents: 0 }, { status: 'resolved' }]);
    expect(h.trading.allocationSnapshot().uncertain).toBe(false);
    expect(await h.stored.getManualCommands(accountKey(h.scope))).toHaveLength(3);
    await h.trading.dispose(); const reopened = await h.make();
    expect(reopened.model.hold).toBeNull();
    await reopened.submitManual('next', { ...ticket, type: 'limit', limitPrice: 106, quantity: 8 });
    expect(h.writes.submitOrder).toHaveBeenCalledTimes(3);
    expect(h.writes.cancelOrder).toHaveBeenCalledOnce();
    expect(order.status).toBe('filled');
  });

  it('recovers a lost acknowledgement automatically after reopening without resubmission', async () => {
    const h = await setup();
    vi.mocked(h.writes.submitOrder).mockImplementationOnce(async request => { h.accept(request); throw new Error('response lost'); });
    await h.trading.submitManual('lost', ticket); await h.trading.dispose();
    const reopened = await h.make(); fillEntry(h);
    await reopened.tick();
    expect(reopened.model.manual[0]).toMatchObject({ status: 'resolved', commitmentCents: 0, order: { status: 'filled' } });
    expect(reopened.model.observation?.positions[0].qty).toBe(1);
    expect(h.writes.submitOrder).toHaveBeenCalledOnce();
  });

  it('retries failed manual lookups while continuing Robot and account observations', async () => {
    const h = await setup();
    await h.trading.submitManual('manual', { ...ticket, symbol: 'OTHER' });
    await h.trading.approve('robot', h.plan); await h.trading.pause('run-robot');
    vi.mocked(h.reads.getOrders).mockResolvedValue([]);
    vi.mocked(h.reads.getOrder).mockRejectedValueOnce(new Error('temporarily unavailable'));
    await h.trading.tick();
    expect(h.trading.model.reconciliationError).toBe('temporarily unavailable');
    expect(h.trading.model.manual[0].commitmentCents).toBe(10600);
    expect(h.trading.model.runs[0].blocked).toBeNull();
    expect(h.trading.model.observation?.account.id).toBe(h.account.id);
    await h.trading.tick();
    expect(h.trading.model.reconciliationError).toBeNull();
    expect(h.trading.model.manual[0].error).toBeNull();
    expect(h.writes.submitOrder).toHaveBeenCalledOnce();
  });

  it('does not regress a partial fill or its remaining commitment on an older observation', async () => {
    const h = await setup();
    await h.trading.submitManual('partial', { ...ticket, type: 'limit', limitPrice: 106, quantity: 10 });
    const earlier = structuredClone([...h.orders.values()][0]); fillEntry(h, 4);
    await h.trading.tick();
    vi.mocked(h.reads.getOrders).mockResolvedValueOnce([earlier]);
    await h.trading.tick();
    expect(h.trading.model.manual[0]).toMatchObject({ commitmentCents: 63600, order: { filledQty: 4, status: 'partially_filled' } });
    expect(h.trading.model.observation?.orders[0].filledQty).toBe(4);
  });

  it('keeps uncertain commands reserved when automatic lookups find no order', async () => {
    const h = await setup(); vi.mocked(h.writes.submitOrder).mockRejectedValueOnce(new Error('timeout'));
    await h.trading.submitManual('absent', ticket);
    await h.trading.tick(); await h.trading.tick();
    expect(h.trading.model.manual[0]).toMatchObject({ status: 'uncertain', commitmentCents: 10600 });
    expect(h.writes.submitOrder).toHaveBeenCalledOnce();
  });

  it('accounts for fills included in the submission response and confirms a fill during cancellation', async () => {
    const h = await setup();
    vi.mocked(h.writes.submitOrder).mockImplementationOnce(async request => {
      h.accept(request); return structuredClone(fillEntry(h, 4));
    });
    const submitted = await h.trading.submitManual('immediate-partial', { ...ticket, quantity: 10 });
    expect(submitted).toMatchObject({ status: 'acknowledged', commitmentCents: 63600, order: { filledQty: 4 } });
    await h.trading.cancelManual('cancel-partial', submitted.brokerOrderId!);
    fillEntry(h, 10); await h.trading.tick();
    expect(h.trading.model.manual).toMatchObject([
      { status: 'resolved', commitmentCents: 0, order: { status: 'filled', filledQty: 10 } },
      { status: 'resolved', commitmentCents: 0, order: { status: 'filled', filledQty: 10 } },
    ]);
    expect(h.trading.model.observation?.positions[0].qty).toBe(10);
    expect(h.writes.submitOrder).toHaveBeenCalledOnce();
  });
});

describe('broker-held Robot protection', () => {
  it.each(['old-contract', 'missing-exit-state', 'unprotected-entry'])('rejects %s records without migrating or deleting them', async kind => {
    const h = await setup(); await h.trading.approve('format', h.plan); await h.trading.tick();
    const saved = structuredClone(h.trading.model.runs[0]);
    const changed = kind === 'old-contract' ? { ...saved, contract: 'paca-snapshots-1' }
      : kind === 'missing-exit-state' ? { ...saved, exitRequested: undefined }
        : { ...saved, commands: saved.commands.map(command => command.action.kind === 'submit'
          ? { ...command, action: { ...command.action, request: { ...command.action.request, stopLoss: undefined } } } : command) };
    await h.trading.dispose(); await h.db.put('runs', changed);
    const reopened = await h.make();
    expect(reopened.model.hold).toContain('incompatible');
    expect(await h.db.get('runs', saved.key)).toEqual(changed);
    await expect(reopened.submitManual('blocked', ticket)).rejects.toThrow('incompatible');
    expect(h.writes.submitOrder).toHaveBeenCalledOnce(); expect(h.writes.cancelOrder).not.toHaveBeenCalled();
  });
  it('retains older manual command evidence and holds execution on connection', async () => {
    const h = await setup(), command = await h.trading.submitManual('format', ticket);
    const changed = { ...command, contract: 'paca-snapshots-1' };
    await h.trading.dispose(); await h.db.put('manualCommands', changed);
    const reopened = await h.make();
    expect(reopened.model.hold).toContain('incompatible');
    expect(await h.db.get('manualCommands', command.key)).toEqual(changed);
    expect(h.writes.submitOrder).toHaveBeenCalledOnce();
  });
  it('commits an attached GTC stop before entry and retains it through pause, disarm and reconnect', async () => {
    const h = await setup({ environment: 'live' }); await h.trading.armLiveRobots(true);
    await h.trading.approve('protected', h.plan); await h.trading.tick();
    const request = vi.mocked(h.writes.submitOrder).mock.calls[0][0];
    expect(request).toMatchObject({ timeInForce: 'gtc', stopLoss: { stopPrice: 103.88 } });
    expect((await h.stored.getActiveRuns(accountKey(h.scope)))[0].commands[0].action).toEqual({ kind: 'submit', request });
    fillEntry(h); await h.trading.tick();
    expect(protectionStatus(h.trading.model.runs[0]).state).toBe('active');
    await h.trading.pause('run-protected'); await h.trading.armLiveRobots(false); await h.trading.dispose();
    const reopened = await h.make(); await reopened.tick();
    expect(reopened.model.runs[0].state).toBe('paused');
    expect(protectionStatus(reopened.model.runs[0]).state).toBe('active');
    expect(h.writes.cancelOrder).not.toHaveBeenCalled(); expect(h.writes.submitOrder).toHaveBeenCalledOnce();
  });
  it('attributes an attached stop filled entirely while the browser was offline without sending another sell', async () => {
    const h = await setup(); await h.trading.approve('offline', h.plan); await h.trading.tick(); await h.trading.dispose();
    const entry = fillEntry(h), stop = entry.legs![0];
    Object.assign(stop, { status: 'filled', filledQty: entry.qty, filledAvgPrice: 103 }); h.positions([]);
    h.activities.push({ id: 'offline-stop-fill', orderId: stop.id, symbol: 'TEST', side: 'sell', qty: entry.qty!, price: 103,
      transactionTime: new Date(NOW + 1000).toISOString(), type: 'fill' });
    const reopened = await h.make(); await reopened.tick();
    expect(reopened.model.hold).toBeNull();
    expect(reopened.model.runs[0].blocked).toBeNull();
    expect(ownedInventory(reopened.model.runs[0]).quantity).toBe(0);
    expect(reopened.model.runs[0].fills).toHaveLength(2);
    await reopened.close('run-offline');
    expect(reopened.model.runs[0].state).toBe('ended');
    expect(h.writes.submitOrder).toHaveBeenCalledOnce(); expect(h.writes.cancelOrder).not.toHaveBeenCalled();
    expect((await h.stored.getRunHistory(accountKey(h.scope)))[0].orders).toHaveLength(2);
  });
  it('recovers a lost protected-entry acknowledgement by its original identity', async () => {
    const h = await setup(); await h.trading.approve('lost', h.plan);
    vi.mocked(h.writes.submitOrder).mockImplementationOnce(async request => { h.accept(request); throw new Error('response lost'); });
    await h.trading.tick(); expect(h.trading.model.runs[0].commands[0].status).toBe('uncertain');
    await h.trading.dispose(); const reopened = await h.make(); await reopened.tick();
    expect(reopened.model.runs[0].commands[0].status).toBe('acknowledged');
    expect(reopened.model.runs[0].orders).toHaveLength(2);
    expect(h.writes.submitOrder).toHaveBeenCalledOnce();
  });
  it.each(['missing', 'foreign', 'wrong-stop', 'wrong-entry-type'])('does not claim protection or fall back to a naked entry for %s broker evidence', async kind => {
    const h = await setup(); await h.trading.approve('bad-leg', h.plan);
    vi.mocked(h.writes.submitOrder).mockImplementationOnce(async request => {
      const order = h.accept(request);
      if (kind === 'missing') delete order.legs;
      else if (kind === 'foreign') order.legs![0].symbol = 'OTHER';
      else if (kind === 'wrong-entry-type') order.type = 'limit';
      else order.legs![0].stopPrice = 1;
      return order;
    });
    await h.trading.tick();
    expect(h.trading.model.runs[0].commands[0].status).toBe('uncertain');
    expect(h.trading.model.runs[0].orders).toEqual([]);
    await h.trading.tick(); expect(h.writes.submitOrder).toHaveBeenCalledOnce();
  });
  it('cancels a partial entry, waits for group cancellation, then protects only the confirmed remainder', async () => {
    const h = await setup({ environment: 'live' }); await h.trading.armLiveRobots(true);
    await h.trading.approve('partial', h.plan); await h.trading.tick(); const entry = fillEntry(h, 2);
    await h.trading.reconcile(); expect(protectionStatus(h.trading.model.runs[0]).state).toBe('pending');
    await h.trading.armLiveRobots(false); await h.trading.tick(); await h.trading.tick();
    expect(h.writes.cancelOrder).toHaveBeenCalledOnce(); expect(h.writes.submitOrder).toHaveBeenCalledOnce();
    entry.status = 'canceled'; await h.trading.tick();
    expect(vi.mocked(h.writes.submitOrder).mock.calls[1][0]).toMatchObject({ side: 'sell', qty: 2, type: 'stop', timeInForce: 'gtc', stopPrice: 103.88 });
    await h.trading.tick(); expect(h.writes.submitOrder).toHaveBeenCalledTimes(2);
    expect(protectionStatus(h.trading.model.runs[0]).state).toBe('active');
  });
  it('keeps a durable strategy exit waiting through delayed stop cancellation', async () => {
    const h = await setup(); await h.trading.approve('exit', h.plan); await h.trading.tick(); const entry = fillEntry(h);
    h.input.market.quote!.priceUsd = 80;
    await h.trading.tick(); await h.trading.tick();
    expect(h.trading.model.runs[0]).toMatchObject({ state: 'running', exitRequested: true });
    expect(h.writes.submitOrder).toHaveBeenCalledOnce();
    entry.legs![0].status = 'canceled'; await h.trading.tick();
    expect(vi.mocked(h.writes.submitOrder).mock.calls[1][0]).toMatchObject({ side: 'sell', type: 'market', qty: entry.qty });
    await h.trading.tick(); expect(h.writes.submitOrder).toHaveBeenCalledTimes(2);
    expect(h.writes.cancelOrder).toHaveBeenCalledOnce();
  });
  it('does not oversell when the protective stop fills during cancellation', async () => {
    const h = await setup(); await h.trading.approve('race', h.plan); await h.trading.tick(); const entry = fillEntry(h), stop = entry.legs![0];
    await h.trading.close('run-race'); await h.trading.tick();
    Object.assign(stop, { status: 'filled', filledQty: entry.qty, filledAvgPrice: 103 }); h.positions([]);
    h.activities.push({ id: 'stop-fill', orderId: stop.id, symbol: 'TEST', side: 'sell', qty: entry.qty!, price: 103, transactionTime: new Date(NOW).toISOString(), type: 'fill' });
    await h.trading.tick();
    expect(h.trading.model.runs[0].state).toBe('ended'); expect(h.writes.submitOrder).toHaveBeenCalledOnce();
  });
  it('keeps the stop when current data cannot support an immediate exit', async () => {
    const h = await setup(); await h.trading.approve('stale', h.plan); await h.trading.tick(); fillEntry(h);
    h.quote.quoteAt = NOW - 31_000;
    await expect(h.trading.close('run-stale')).rejects.toThrow('fresh');
    expect(h.writes.cancelOrder).not.toHaveBeenCalled(); expect(h.writes.submitOrder).toHaveBeenCalledOnce();
  });
  it('restores the exit transition after interruption and requires explicit Close to continue', async () => {
    const h = await setup({ environment: 'live' }); await h.trading.armLiveRobots(true);
    await h.trading.approve('resume-exit', h.plan); await h.trading.tick(); const entry = fillEntry(h);
    h.input.market.quote!.priceUsd = 80; await h.trading.tick(); await h.trading.dispose();
    entry.legs![0].status = 'canceled'; const reopened = await h.make(); await reopened.tick();
    expect(reopened.model.runs[0]).toMatchObject({ state: 'paused', exitRequested: true });
    expect(h.writes.submitOrder).toHaveBeenCalledOnce(); await reopened.close('run-resume-exit');
    expect(vi.mocked(h.writes.submitOrder).mock.calls[1][0]).toMatchObject({ side: 'sell', type: 'market', qty: entry.qty });
  });
  it('allows explicit protection of a paused position after its broker stop was canceled', async () => {
    const h = await setup({ environment: 'live' }); await h.trading.armLiveRobots(true);
    await h.trading.approve('repair', h.plan); await h.trading.tick(); const entry = fillEntry(h);
    await h.trading.pause('run-repair'); entry.legs![0].status = 'canceled'; await h.trading.armLiveRobots(false); await h.trading.tick();
    expect(protectionStatus(h.trading.model.runs[0]).state).toBe('unprotected');
    await h.trading.protect('run-repair');
    expect(vi.mocked(h.writes.submitOrder).mock.calls[1][0]).toMatchObject({ side: 'sell', type: 'stop', qty: entry.qty, timeInForce: 'gtc' });
    expect(h.trading.model.runs[0].state).toBe('paused');
  });
  it('rejects a changed child stop discovered through its direct lookup after the parent has resolved', async () => {
    const h = await setup(); await h.trading.approve('changed', h.plan); await h.trading.tick(); const entry = fillEntry(h);
    await h.trading.tick(); entry.legs![0].stopPrice = 1;
    await h.trading.tick();
    expect(h.trading.model.runs[0]).toMatchObject({ state: 'paused', blocked: expect.stringContaining('does not match') });
    expect(protectionStatus(h.trading.model.runs[0]).state).toBe('unknown');
    expect(h.writes.cancelOrder).not.toHaveBeenCalled(); expect(h.writes.submitOrder).toHaveBeenCalledOnce();
  });
  it('recovers both parent and stop if storing the broker acknowledgement fails', async () => {
    const h = await setup(); await h.trading.approve('commit', h.plan);
    const save = h.stored.saveRun.bind(h.stored);
    const spy = vi.spyOn(h.stored, 'saveRun').mockImplementation(async run => {
      if (run.orders.length) throw new Error('result commit failed');
      await save(run);
    });
    await h.trading.tick();
    expect((await h.stored.getActiveRuns(accountKey(h.scope)))[0].commands[0].status).toBe('pending');
    spy.mockRestore(); await h.trading.dispose(); const reopened = await h.make(); await reopened.tick();
    expect(reopened.model.runs[0].orders).toHaveLength(2);
    expect(reopened.model.runs[0].blocked).toBeNull(); expect(h.writes.submitOrder).toHaveBeenCalledOnce();
  });
  it('blocks re-entry while a canceled parent still has a nonterminal attached stop', async () => {
    const h = await setup({ template: wickCapture }); await h.trading.approve('leftover', h.plan); await h.trading.tick();
    const entry = [...h.orders.values()][0]; entry.status = 'canceled';
    vi.mocked(h.reads.getOrder).mockImplementation(async id => structuredClone(id === entry.id ? entry : entry.legs![0]));
    vi.mocked(h.reads.getOrders).mockImplementation(async () => structuredClone([entry, entry.legs![0]]));
    await h.trading.tick();
    expect(protectionStatus(h.trading.model.runs[0]).state).toBe('pending');
    expect(h.trading.model.runs[0].latestDecision?.vetoes).toContainEqual(expect.objectContaining({ code: 'prior_stop_pending' }));
    expect(h.writes.submitOrder).toHaveBeenCalledOnce();
  });
});

describe('one durable account executor', () => {
  it('waits for transaction completion even if the intent put request has succeeded', async () => {
    const h = await setup(), original = IDBObjectStore.prototype.put;
    const spy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function(this: IDBObjectStore, value, key) {
      const request = original.call(this, value, key);
      if (this.name === 'manualCommands') request.addEventListener('success', () => this.transaction.abort(), { once: true });
      return request;
    });
    try {
      await expect(h.trading.submitManual('aborted-commit', ticket)).rejects.toMatchObject({ name: 'AbortError' });
      expect(h.writes.submitOrder).not.toHaveBeenCalled();
      expect(await h.stored.getManualCommands(accountKey(h.scope))).toEqual([]);
    } finally { spy.mockRestore(); }
  });
  it('requires manual live arming and resets arming on a new session', async () => {
    const h = await setup({ environment: 'live' });
    await expect(h.trading.submitManual('live', ticket)).rejects.toThrow('armed');
    await expect(h.trading.approve('robot', h.plan)).rejects.toThrow('Enable live Robot');
    await h.trading.armLive(true); await h.trading.submitManual('live', ticket);
    await expect(h.trading.approve('robot', h.plan)).rejects.toThrow('Enable live Robot');
    expect(h.writes.submitOrder).toHaveBeenCalledOnce();
    await h.trading.dispose(); const reopened = await h.make();
    expect(reopened.model.liveArmed).toBe(false);
    await expect(reopened.cancelManual('cancel-live', [...h.orders.keys()][0])).rejects.toThrow('Arm');
  });
  it('requires independent live Robot arming and rejects foreign plans', async () => {
    const h = await setup({ environment: 'live' });
    await h.trading.armLiveRobots(true);
    expect(h.trading.model).toMatchObject({ liveArmed: false, liveRobotsArmed: true });
    await expect(h.trading.submitManual('manual', ticket)).rejects.toThrow('armed');
    for (const scope of [{ ...h.plan.scope, environment: 'paper' as const }, { ...h.plan.scope, accountId: 'foreign' }]) {
      const proposal = { ...h.plan, scope };
      await expect(h.trading.approve('foreign', { ...proposal, opportunityKey: opportunityKey(proposal) })).rejects.toThrow('account and environment');
    }
    await h.trading.approve('live-run', h.plan); await h.trading.tick();
    expect(h.writes.submitOrder).toHaveBeenCalledOnce();
    expect(h.trading.model.runs[0].approved.scope.environment).toBe('live');
  });
  it('continues protective exits after live Robot entries are disabled', async () => {
    const h = await setup({ environment: 'live' });
    await h.trading.armLiveRobots(true); await h.trading.approve('live-run', h.plan); await h.trading.tick();
    const order = [...h.orders.values()][0], qty = order.qty!;
    order.filledQty = qty; order.status = 'filled'; order.filledAvgPrice = 106;
    h.activities.push({ id: 'live-fill', orderId: order.id, symbol: 'TEST', side: 'buy', qty, price: 106, transactionTime: new Date(NOW).toISOString(), type: 'fill' });
    h.positions([{ symbol: 'TEST', qty, side: 'long', avgEntryPrice: 106, currentPrice: 80, marketValue: qty * 80, unrealizedPl: qty * -26, unrealizedPlpc: -26 / 106 }]);
    h.input.market.quote = { at: new Date(NOW).toISOString(), priceUsd: 80, bidUsd: 80, askUsd: 80 };
    await h.trading.armLiveRobots(false); await h.trading.tick();
    expect(h.trading.model).toMatchObject({ liveArmed: false, liveRobotsArmed: false });
    expect(h.writes.cancelOrder).toHaveBeenCalledWith(order.legs![0].id);
    expect(h.writes.submitOrder).toHaveBeenCalledOnce();
    order.legs![0].status = 'canceled'; await h.trading.tick();
    expect(h.writes.submitOrder).toHaveBeenCalledTimes(2);
    expect(vi.mocked(h.writes.submitOrder).mock.calls[1][0]).toMatchObject({ side: 'sell', qty });
  });
  it('resets live arming and restores paused runs while allowing cancellation and close', async () => {
    const h = await setup({ environment: 'live' });
    await h.trading.armLiveRobots(true); const run = await h.trading.approve('live-run', h.plan); await h.trading.tick();
    await h.trading.dispose(); const reopened = await h.make();
    expect(reopened.model).toMatchObject({ hold: null, liveArmed: false, liveRobotsArmed: false, runs: [{ state: 'paused' }] });
    await expect(reopened.resume(run.id)).rejects.toThrow('Enable live Robot');
    await reopened.tick(); expect(h.writes.submitOrder).toHaveBeenCalledOnce();
    await reopened.close(run.id); expect(h.writes.cancelOrder).toHaveBeenCalledOnce();
    [...h.orders.values()][0].status = 'canceled'; await reopened.reconcile();
    expect(reopened.model.runs[0]).toMatchObject({ state: 'ended', active: 0 });
  });
  it('disarming live Robot entries cancels a working entry without admitting another buy', async () => {
    const h = await setup({ environment: 'live' });
    await h.trading.armLiveRobots(true); await h.trading.approve('live-run', h.plan); await h.trading.tick();
    await h.trading.armLiveRobots(false); await h.trading.tick();
    expect(h.writes.cancelOrder).toHaveBeenCalledOnce();
    expect(h.writes.submitOrder).toHaveBeenCalledOnce();
    expect(h.trading.model.runs[0].latestDecision?.vetoes).toContainEqual(expect.objectContaining({ code: 'live_robot_entries_disabled' }));
  });
  it('fences an entry when disarmed during intent persistence and ignores obsolete arming requests', async () => {
    const h = await setup({ environment: 'live' });
    await Promise.all([h.trading.armLiveRobots(true), h.trading.armLiveRobots(false)]);
    expect(h.trading.model.liveRobotsArmed).toBe(false);
    await h.trading.armLiveRobots(true); await h.trading.approve('live-run', h.plan);
    const saved = pending<void>(), release = pending<void>(), save = h.stored.saveRun.bind(h.stored);
    vi.spyOn(h.stored, 'saveRun').mockImplementation(async run => {
      await save(run);
      if (run.commands.at(-1)?.status === 'pending') { saved.resolve(); await release.promise; }
    });
    const tick = h.trading.tick(); await saved.promise;
    const disarm = h.trading.armLiveRobots(false);
    expect(h.trading.model.liveRobotsArmed).toBe(false);
    release.resolve(); await Promise.all([tick, disarm]);
    expect(h.writes.submitOrder).not.toHaveBeenCalled();
    expect(h.trading.model.runs[0]).toMatchObject({ state: 'paused', commands: [{ status: 'not_sent' }] });
  });
  it('detaches approval inputs, command results and read models from internal execution', async () => {
    const h = await setup(), run = await h.trading.approve('frozen', h.plan);
    h.plan.parameters.fastPeriod = 40;
    (run.approved.plan.parameters as Record<string, number>).fastPeriod = 50;
    (h.trading.model.runs[0].approved.plan.parameters as Record<string, number>).fastPeriod = 60;
    await h.trading.tick();
    expect(h.writes.submitOrder).toHaveBeenCalledOnce();
    const stored = await h.stored.getRun(accountKey(h.scope), run.id);
    expect(stored?.approved.plan.parameters.fastPeriod).toBe(2);
  });
  it('keeps research corruption local and skips unchanged execution writes and complete history scans', async () => {
    const h = await setup(); await h.trading.approve('one', h.plan); await h.trading.pause('run-one');
    await h.db.put('research', { key: 'damaged', scope: accountKey(h.scope), kind: 'proposal', proposal: {} });
    await expect(new ResearchDocuments(h.db, accountKey(h.scope)).load()).rejects.toThrow();
    const save = vi.spyOn(h.stored, 'saveRun');
    await h.trading.reconcile(); await h.trading.reconcile();
    expect(save).not.toHaveBeenCalled();
    expect(h.reads.getTradeActivities).not.toHaveBeenCalled();
    expect(h.trading.model.hold).toBeNull();
    await h.trading.resume('run-one'); await h.trading.tick();
    expect(h.writes.submitOrder).toHaveBeenCalledOnce();
  });
  it.each(['active', 'scope', 'strategy', 'commands'])('does not hide current execution corruption in %s', async field => {
    const h = await setup(), run = await h.trading.approve('corrupt', h.plan); await h.trading.dispose();
    const damaged = { ...run, [field]: field === 'active' ? null : field === 'scope' ? 'wrong' : {} };
    await h.db.put('runs', damaged);
    const reopened = await h.make();
    expect(reopened.model.hold).toContain('corrupt');
    expect(await h.db.get('runs', run.key)).toEqual(damaged);
    await expect(reopened.submitManual('no', ticket)).rejects.toThrow('corrupt');
  });
  it('submits a duplicate manual command once and retains its identity after reload', async () => {
    const h = await setup();
    const [a, b] = await Promise.all([h.trading.submitManual('manual-1', ticket), h.trading.submitManual('manual-1', ticket)]);
    expect(a.id).toBe(b.id); expect(h.writes.submitOrder).toHaveBeenCalledTimes(1);
    await h.trading.dispose(); const reopened = await h.make();
    expect((await reopened.submitManual('manual-1', ticket)).id).toBe('manual-1');
    expect(h.writes.submitOrder).toHaveBeenCalledTimes(1);
  });
  it('never writes when intent commit fails', async () => {
    const h = await setup({ store: store => ({ getActiveRuns: scope => store.getActiveRuns(scope), getRun: (scope, id) => store.getRun(scope, id),
      getRunHistory: scope => store.getRunHistory(scope), saveRun: run => store.saveRun(run), getManualCommands: scope => store.getManualCommands(scope),
      saveManualIntent: async () => { throw new Error('disk failure'); } }) });
    await expect(h.trading.submitManual('one', ticket)).rejects.toThrow('disk failure');
    expect(h.writes.submitOrder).not.toHaveBeenCalled(); expect(h.trading.model.hold).toContain('storage failed');
  });
  it.each(['network', 'malformed', 'server', 'abort'])('retains uncertainty for %s without replay after reload', async kind => {
    const h = await setup();
    vi.mocked(h.writes.submitOrder).mockImplementationOnce(async request => {
      h.accept(request);
      if (kind === 'malformed') return { id: 'bad' } as Order;
      if (kind === 'server') throw new BrokerWriteError('server error', true);
      throw new Error(kind);
    });
    expect((await h.trading.submitManual('one', ticket)).status).toBe('uncertain');
    await expect(h.trading.submitManual('two', { ...ticket, symbol: 'OTHER' })).rejects.toThrow('uncertain');
    await h.trading.dispose(); const reopened = await h.make();
    expect((await reopened.submitManual('one', ticket)).status).toBe('uncertain');
    await reopened.reconcile(); expect(reopened.model.manual[0].status).toBe('acknowledged');
    expect(h.writes.submitOrder).toHaveBeenCalledTimes(1);
  });
  it('does not interpret a missing direct lookup or empty order list as rejection', async () => {
    const h = await setup(); vi.mocked(h.writes.submitOrder).mockRejectedValueOnce(new Error('timeout'));
    await h.trading.submitManual('one', ticket); await h.trading.reconcile();
    expect(h.trading.model.manual[0].status).toBe('uncertain');
    expect(h.writes.submitOrder).toHaveBeenCalledTimes(1);
  });
  it('leaves the earlier committed intent when acknowledgement persistence fails', async () => {
    let failResult = true;
    const h = await setup({ store: store => ({ getActiveRuns: scope => store.getActiveRuns(scope), getRun: (scope, id) => store.getRun(scope, id),
      getRunHistory: scope => store.getRunHistory(scope), saveRun: run => store.saveRun(run), getManualCommands: scope => store.getManualCommands(scope),
      saveManualIntent: async command => { if (failResult && command.status !== 'pending') throw new Error('commit failure'); await store.saveManualIntent(command); } }) });
    await expect(h.trading.submitManual('one', ticket)).rejects.toThrow('commit failure');
    expect((await h.stored.getManualCommands(accountKey(h.scope)))[0].status).toBe('pending');
    failResult = false; await h.trading.dispose(); const reopened = await h.make();
    await reopened.reconcile(); expect(reopened.model.manual[0].status).toBe('acknowledged');
    expect(h.writes.submitOrder).toHaveBeenCalledTimes(1);
  });
  it('retains definitive rejection and does not retry the same identity', async () => {
    const h = await setup(); vi.mocked(h.writes.submitOrder).mockRejectedValueOnce(new BrokerWriteError('rejected', false));
    expect((await h.trading.submitManual('one', ticket)).status).toBe('rejected');
    expect((await h.trading.submitManual('one', ticket)).status).toBe('rejected');
    expect(h.writes.submitOrder).toHaveBeenCalledTimes(1);
  });
  it('holds the lock until an already-sent write settles under the original account', async () => {
    const h = await setup(), result = pending<Order>(), sent = pending<void>();
    vi.mocked(h.writes.submitOrder).mockImplementationOnce(async () => { sent.resolve(); return result.promise; });
    const task = h.trading.submitManual('one', ticket); await sent.promise;
    const closing = h.trading.dispose();
    await expect(AccountOwnership.acquire(h.scope, h.locks)).rejects.toThrow('another tab');
    await expect(h.trading.submitManual('two', ticket)).rejects.toThrow('closed');
    result.resolve(h.accept({ ...ticket, qty: 1, type: 'market', clientOrderId: 'paca-one' }));
    await task; await closing;
    const owner = await AccountOwnership.acquire(h.scope, h.locks); await owner.release();
    expect((await h.stored.getManualCommands(accountKey(h.scope)))[0].status).toBe('acknowledged');
  });
  it('fences a command waiting on old-session reads', async () => {
    const h = await setup(), read = pending<Account>();
    vi.mocked(h.reads.getAccount).mockReturnValueOnce(read.promise);
    const task = h.trading.submitManual('one', ticket);
    await Promise.resolve(); const closing = h.trading.dispose(); read.resolve(h.account);
    await expect(task).rejects.toThrow('closed'); await closing;
    expect(h.writes.submitOrder).not.toHaveBeenCalled();
  });
  it('does not let a newer trade refresh a stale bid/ask for automatic limits', async () => {
    const h = await setup(); h.quote.quoteAt = NOW - 31_000;
    await expect(h.trading.submitManual('one', { ...ticket, type: 'limit', limitPrice: 106 })).rejects.toThrow('fresh');
    expect(h.writes.submitOrder).not.toHaveBeenCalled();
  });
  it('approves once, reserves the full ceiling and serializes competing starts/manual orders', async () => {
    const h = await setup(); h.account.buyingPower = 1500;
    const [a, b] = await Promise.all([h.trading.approve('approve', h.plan), h.trading.approve('approve', h.plan)]);
    expect(a.id).toBe(b.id); expect(h.trading.model.runs).toHaveLength(1);
    const other = { ...h.plan, id: 'other', symbol: 'OTHER' }; other.opportunityKey = opportunityKey(other);
    await expect(h.trading.approve('second', other)).rejects.toThrow('capital ceiling');
    await expect(h.trading.submitManual('claimed', ticket)).rejects.toThrow('claims');
    await expect(h.trading.submitManual('large', { ...ticket, symbol: 'OTHER', quantity: 6 })).rejects.toThrow('capital');
  });
  it('restores an open run paused and requires reconciliation and explicit resume', async () => {
    const h = await setup(); const run = await h.trading.approve('approve', h.plan);
    await h.trading.dispose(); const reopened = await h.make();
    expect(reopened.model.runs[0].state).toBe('paused');
    expect(reopened.model.runs[0].blocked).toContain('Reopened');
    await reopened.tick(); expect(h.writes.submitOrder).not.toHaveBeenCalled();
    await reopened.resume(run.id); expect(reopened.model.runs[0].state).toBe('running');
  });
  it('ends at the approved horizon only after flat terminal reconciliation and releases its ceiling', async () => {
    const h = await setup(), run = await h.trading.approve('scheduled', h.plan);
    h.time(Date.parse(run.approved.plan.intendedEnd));
    await h.trading.tick(); expect(h.trading.model.runs[0].state).toBe('closing');
    await h.trading.tick(); expect(h.trading.model.runs[0]).toMatchObject({ active: 0, state: 'ended', supervisionInterrupted: true });
    expect(h.writes.submitOrder).not.toHaveBeenCalled();
    expect(await h.stored.getActiveRuns(accountKey(h.scope))).toEqual([]);
    expect(await h.stored.getRunHistory(accountKey(h.scope))).toHaveLength(1);
  });
  it.each(['paper', 'live'] as const)('never adopts external holdings and pauses on observable external conflict in %s', async environment => {
    const h = await setup({ environment });
    if (environment === 'live') await h.trading.armLiveRobots(true);
    h.positions([{ symbol: 'TEST', qty: 1, side: 'long', avgEntryPrice: 100, currentPrice: 100, marketValue: 100, unrealizedPl: 0, unrealizedPlpc: 0 }]);
    await expect(h.trading.approve('one', h.plan)).rejects.toThrow('external');
    h.positions([]); await h.trading.approve('two', h.plan);
    h.positions([{ symbol: 'TEST', qty: 2, side: 'long', avgEntryPrice: 100, currentPrice: 100, marketValue: 200, unrealizedPl: 0, unrealizedPlpc: 0 }]);
    await h.trading.tick(); expect(h.trading.model.runs[0].state).toBe('paused');
    expect(h.trading.model.runs[0].blocked).toContain('External'); expect(h.writes.submitOrder).not.toHaveBeenCalled();
  });
  it('commits robot intent before submitting and coalesces overlapping ticks', async () => {
    const h = await setup(); await h.trading.approve('one', h.plan);
    vi.mocked(h.writes.submitOrder).mockImplementationOnce(async request => {
      const runs = await h.stored.getActiveRuns(accountKey(h.scope));
      expect(runs[0].commands[0].status).toBe('pending');
      expect(runs[0].commands[0].action).toEqual({ kind: 'submit', request });
      return h.accept(request);
    });
    await Promise.all([h.trading.tick(), h.trading.tick(), h.trading.tick()]);
    expect(h.writes.submitOrder).toHaveBeenCalledTimes(1);
  });
  it('does not release capital or independently sell after cancel acknowledgement and a partial fill', async () => {
    const h = await setup(); const run = await h.trading.approve('one', h.plan); await h.trading.tick();
    const order = [...h.orders.values()][0]; order.filledQty = 2; order.status = 'partially_filled'; order.filledAvgPrice = 106;
    h.activities.push({ id: 'fill', orderId: order.id, symbol: 'TEST', side: 'buy', qty: 2, price: 106, transactionTime: new Date(NOW).toISOString(), type: 'partial_fill' });
    h.positions([{ symbol: 'TEST', qty: 2, side: 'long', avgEntryPrice: 106, currentPrice: 106, marketValue: 212, unrealizedPl: 0, unrealizedPlpc: 0 }]);
    await h.trading.close(run.id);
    expect(h.writes.cancelOrder).toHaveBeenCalledTimes(1);
    await h.trading.tick(); await h.trading.tick();
    expect(h.writes.submitOrder).toHaveBeenCalledTimes(1); expect(h.writes.cancelOrder).toHaveBeenCalledTimes(1);
    expect(h.trading.model.runs[0].active).toBe(1); expect(ownedInventory(h.trading.model.runs[0]).quantity).toBe(2);
    order.status = 'canceled'; await h.trading.tick();
    expect(h.writes.submitOrder).toHaveBeenCalledTimes(2);
    expect(vi.mocked(h.writes.submitOrder).mock.calls[1][0]).toMatchObject({ side: 'sell', qty: 2 });
  });
  it('current execution corruption holds the account without erasing evidence', async () => {
    const h = await setup(); const run = await h.trading.approve('one', h.plan); await h.trading.dispose();
    await h.db.put('runs', { ...run, ceilingCents: -1 });
    const reopened = await h.make(); expect(reopened.model.hold).toContain('corrupt');
    await expect(reopened.submitManual('manual', ticket)).rejects.toThrow('corrupt');
    expect(await h.db.get('runs', run.key)).toMatchObject({ ceilingCents: -1 });
  });
  it('validates nested stored decision values without trusting a trace-shaped object', async () => {
    const h = await setup(); await h.trading.approve('trace', h.plan); await h.trading.tick();
    const run = h.trading.model.runs[0]; await h.trading.dispose();
    await h.db.put('runs', { ...run, latestDecision: { ...run.latestDecision, conditions: [{ code: 'fake', inputRef: 'fake', operator: 'eq', threshold: true, result: 'pass', observed: [] }] } });
    const reopened = await h.make(); expect(reopened.model.hold).toContain('corrupt');
    expect(h.writes.submitOrder).toHaveBeenCalledTimes(1);
  });
  it('exposes detached full commitments to research and distinguishes active runs from uncertainty', async () => {
    const h = await setup(); await h.trading.approve('allocation', h.plan);
    const state = h.trading.allocationSnapshot();
    expect(state).toEqual({ uncertain: false, commitments: [{ symbol: h.plan.symbol, ceilingCents: h.plan.capital.ceilingCents }] });
    state.commitments[0].ceilingCents = 1;
    expect(h.trading.allocationSnapshot().commitments[0].ceilingCents).toBe(h.plan.capital.ceilingCents);
    const response = pending<Order>(); vi.mocked(h.writes.submitOrder).mockImplementationOnce(() => response.promise);
    const tick = h.trading.tick(); await vi.waitFor(() => expect(h.writes.submitOrder).toHaveBeenCalledOnce());
    expect(h.trading.allocationSnapshot().uncertain).toBe(true);
    response.resolve(h.accept(vi.mocked(h.writes.submitOrder).mock.calls[0][0])); await tick;
    expect(h.trading.allocationSnapshot().uncertain).toBe(false);
  });
  it('requires actual ownership primitives and refuses a second tab without queuing takeover', async () => {
    const h = await setup();
    await expect(AccountOwnership.acquire(h.scope, null)).rejects.toThrow('Web Locks');
    await expect(AccountOwnership.acquire(h.scope, h.locks)).rejects.toThrow('another tab');
    await h.trading.dispose(); const next = await AccountOwnership.acquire(h.scope, h.locks); await next.release();
  });
});

function prepare24(h: Awaited<ReturnType<typeof setup>>, at: number) {
  const date = tradingDate(at), full = fullTradingSession({ date, open: calendarTimeToUtc(date, '09:30'), close: calendarTimeToUtc(date, '16:00') });
  const iso = (value: number) => new Date(value).toISOString(), plan = h.plan;
  plan.sessionMode = '24x5';
  plan.session = { ...plan.session, calendarId: FULL_SESSION_CALENDAR, tradingDate: date, openAt: iso(full.open), closeAt: iso(full.close), calendarAsOf: iso(at - 60_000) };
  plan.generatedAt = plan.dataCutoff = iso(at - 30_000); plan.validUntil = iso(at + 300_000);
  plan.entryWindow = { from: iso(at - 30_000), to: iso(full.close - 15 * 60_000) }; plan.intendedEnd = iso(full.close - 5 * 60_000);
  plan.opportunityKey = opportunityKey(plan);
  h.time(at); h.quote.tradeAt = h.quote.quoteAt = h.quote.receivedAt = at; h.quote.feed = isOvernightTime(at) ? 'boats' : 'sip';
  h.input.market.session = structuredClone(plan.session); h.input.market.dataCutoff = iso(at); h.input.market.quote!.at = iso(at);
  h.input.market.bars = h.input.market.bars.map(bar => ({ ...bar, t: iso(Date.parse(bar.t) + at - NOW) }));
  vi.mocked(h.reads.getClock).mockImplementation(async () => ({ isOpen: false, timestamp: iso(at), nextOpen: iso(calendarTimeToUtc(date, '09:30')), nextClose: iso(calendarTimeToUtc(date, '16:00')) }));
}

describe('24/5 Robot execution', () => {
  it.each(['2026-09-21T02:00:00Z', '2026-09-21T11:00:00Z', '2026-09-21T22:00:00Z'])('approves and enters Trend with an eligible limit at %s', async time => {
    const h = await setup(); prepare24(h, Date.parse(time));
    await h.trading.approve('extended', h.plan); await h.trading.tick();
    expect(h.writes.submitOrder).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ side: 'buy', type: 'limit', limitPrice: 106, extendedHours: true, timeInForce: 'day' }));
    expect(vi.mocked(h.writes.submitOrder).mock.calls[0][0].stopLoss).toBeUndefined();
    expect(h.trading.model.runs[0]).toMatchObject({ state: 'running', blocked: null });
    await h.trading.dispose(); const reopened = await h.make();
    expect(reopened.model.hold).toBeNull(); expect(reopened.model.runs[0].state).toBe('paused');
  });
  it('protects a confirmed overnight fill, then confirms stop cancellation before a limit exit', async () => {
    const h = await setup(), at = Date.parse('2026-09-21T02:00:00Z'); prepare24(h, at);
    await h.trading.approve('extended', h.plan); await h.trading.tick();
    fillEntry(h); h.activities[0].transactionTime = new Date(at).toISOString();
    await h.trading.tick();
    expect(vi.mocked(h.writes.submitOrder).mock.calls[1][0]).toMatchObject({ side: 'sell', type: 'stop', timeInForce: 'gtc', stopPrice: 103.88 });
    const stop = [...h.orders.values()][1];
    h.quote.bid = h.quote.price = h.quote.ask = 100;
    await h.trading.tick();
    expect(h.writes.cancelOrder).toHaveBeenCalledExactlyOnceWith(stop.id);
    expect(h.writes.submitOrder).toHaveBeenCalledTimes(2);
    stop.status = 'canceled'; await h.trading.tick();
    expect(vi.mocked(h.writes.submitOrder).mock.calls[2][0]).toMatchObject({ side: 'sell', type: 'limit', limitPrice: 100, extendedHours: true, timeInForce: 'day' });
    expect(h.trading.model.runs[0].blocked).toBeNull();
  });
  it('waits for the correct fresh feed without pausing or sending an entry', async () => {
    const h = await setup(), at = Date.parse('2026-09-21T02:00:00Z'); prepare24(h, at);
    await h.trading.approve('extended', h.plan); h.quote.feed = 'sip'; await h.trading.tick();
    expect(h.writes.submitOrder).not.toHaveBeenCalled(); expect(h.trading.model.runs[0].state).toBe('running');
    h.quote.feed = 'boats'; await h.trading.tick(); expect(h.writes.submitOrder).toHaveBeenCalledOnce();
  });
  it('bounds extended-hours approval by Reg T buying power', async () => {
    const h = await setup(); prepare24(h, Date.parse('2026-09-21T02:00:00Z')); h.account.regtBuyingPower = 100;
    await expect(h.trading.approve('limited', h.plan)).rejects.toThrow('capital ceiling'); expect(h.writes.submitOrder).not.toHaveBeenCalled();
  });
});

it('cancels an overnight partial-entry remainder before protecting only its confirmed holding', async () => {
  const h = await setup(), at = Date.parse('2026-09-21T02:00:00Z'); prepare24(h, at);
  await h.trading.approve('partial-extended', h.plan); await h.trading.tick();
  const entry = fillEntry(h, 4); h.activities[0].transactionTime = new Date(at).toISOString();
  await h.trading.tick(); expect(h.writes.cancelOrder).toHaveBeenCalledExactlyOnceWith(entry.id);
  expect(h.writes.submitOrder).toHaveBeenCalledOnce();
  entry.status = 'canceled'; await h.trading.tick();
  expect(vi.mocked(h.writes.submitOrder).mock.calls[1][0]).toMatchObject({ side: 'sell', type: 'stop', qty: 4, timeInForce: 'gtc' });
  expect(h.trading.model.runs[0]).toMatchObject({ state: 'running', blocked: null });
});
