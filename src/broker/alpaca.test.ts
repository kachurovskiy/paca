import { ChartHistory } from '../market/chart-history';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AlpacaApi, AlpacaRequestError } from './alpaca';
import { accountKey } from '../core/account';
import type { Account } from '../core/types';
function alpacaAccountScope(account: Account, environment: 'paper' | 'live') {
  const scope = { broker: 'alpaca', accountId: account.id!, environment }; accountKey(scope); return Object.freeze(scope);
}
import type { Credentials } from '../core/types';

const credentials: Credentials = { keyId: 'paper-key-example', secretKey: 'secret-example', environment: 'paper' };
const account = { equity: '100100.25', last_equity: '100000', cash: '20000', buying_power: '80000', portfolio_value: '100100.25', daytrade_count: 2, trading_blocked: false, status: 'ACTIVE', created_at: '2019-05-24T15:34:06.977Z' };
const order = { id: 'order-123', symbol: 'SPY', qty: '2', filled_qty: '0', side: 'buy', type: 'market', status: 'accepted', submitted_at: '2026-09-17T14:00:00Z', filled_avg_price: null, limit_price: null };
const fill = { activity_type: 'FILL', id: '20260917140000000::fill-1', order_id: 'order-123', symbol: 'SPY', side: 'buy', qty: '0.5', price: '602.25', transaction_time: '2026-09-17T14:00:00.000Z', type: 'partial_fill' };
const response = (data: unknown, status = 200): Response => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

describe('AlpacaApi', () => {
  const fetchMock = vi.fn<typeof fetch>();
  beforeEach(() => {
    fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock);
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-17T14:00:00Z'));
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

  it('submits the GTC entry and stop in one request and maps the broker child identity', async () => {
    const child = { ...order, id: 'stop-123', side: 'sell', type: 'stop', status: 'held', time_in_force: 'gtc', stop_price: '98.25',
      submitted_at: null, created_at: order.submitted_at, client_order_id: 'broker-child' };
    fetchMock.mockResolvedValueOnce(response({ ...order, order_class: 'oto', time_in_force: 'gtc', legs: [child] }));
    const result = await new AlpacaApi(credentials).submitOrder({ symbol: 'SPY', side: 'buy', qty: 2, type: 'limit', limitPrice: 100,
      timeInForce: 'gtc', stopLoss: { stopPrice: 98.25 }, clientOrderId: 'protected-entry' });
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({ order_class: 'oto', time_in_force: 'gtc',
      stop_loss: { stop_price: '98.25' }, limit_price: '100', client_order_id: 'protected-entry' });
    expect(result.legs).toEqual([expect.objectContaining({ id: 'stop-123', parentOrderId: order.id, stopPrice: 98.25, timeInForce: 'gtc', status: 'held', submittedAt: order.submitted_at })]);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
  it('recovers attached legs through a nested parent lookup after looking up the stable client ID', async () => {
    fetchMock.mockResolvedValueOnce(response({ ...order, order_class: 'oto', client_order_id: 'protected' }))
      .mockResolvedValueOnce(response({ ...order, order_class: 'oto', legs: [{ ...order, id: 'stop', side: 'sell', type: 'stop', stop_price: '98' }] }));
    expect((await new AlpacaApi(credentials).getOrderByClientOrderId('protected'))?.legs?.[0].parentOrderId).toBe(order.id);
    expect(fetchMock.mock.calls[1][0]).toContain('/order-123?nested=true');
  });
  it('sends standalone GTC stops and rejects unsupported protected requests before any write', async () => {
    const api = new AlpacaApi(credentials), request = { symbol: 'SPY', side: 'buy' as const, qty: 2, type: 'market' as const, timeInForce: 'gtc' as const, stopLoss: { stopPrice: 98 } };
    await expect(api.submitOrder({ ...request, qty: 0.5 })).rejects.toThrow('whole shares');
    await expect(api.submitOrder({ ...request, stopLoss: { stopPrice: 98.001 } })).rejects.toThrow('increments');
    await expect(api.submitOrder({ ...request, type: 'limit', limitPrice: 98 })).rejects.toThrow('below the buy limit');
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockResolvedValueOnce(response({ ...order, side: 'sell', type: 'stop', time_in_force: 'gtc', stop_price: '98' }));
    await api.submitOrder({ symbol: 'SPY', side: 'sell', qty: 2, type: 'stop', timeInForce: 'gtc', stopPrice: 98 });
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({ type: 'stop', stop_price: '98', time_in_force: 'gtc' });
  });

  it('canonicalizes actual clock timestamps and rejects absent session boundaries', async () => {
    fetchMock.mockResolvedValueOnce(response({ is_open: true, timestamp: '2026-09-17T10:00:00-04:00',
      next_open: '2026-09-18T13:30:00Z', next_close: '2026-09-17T20:00:00Z' }));
    expect(await new AlpacaApi(credentials).getClock()).toEqual({ isOpen: true, timestamp: '2026-09-17T14:00:00.000Z',
      nextOpen: '2026-09-18T13:30:00.000Z', nextClose: '2026-09-17T20:00:00.000Z' });
    fetchMock.mockResolvedValueOnce(response({ is_open: true, timestamp: '2026-09-17T14:00:00Z', next_close: null }));
    await expect(new AlpacaApi(credentials).getClock()).rejects.toThrow('incomplete market-clock');
  });

  it('submits a DAY protected buy with its stop in a single request', async () => {
    fetchMock.mockResolvedValueOnce(response({ ...order, order_class: 'oto', time_in_force: 'day', legs: [{ ...order, id: 'child', side: 'sell', type: 'stop', time_in_force: 'day', stop_price: '98', status: 'held' }] }));
    const result = await new AlpacaApi(credentials).submitOrder({ symbol: 'SPY', side: 'buy', type: 'market', qty: 2, timeInForce: 'day', stopLoss: { stopPrice: 98 } });
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({ order_class: 'oto', time_in_force: 'day', stop_loss: { stop_price: '98' }, extended_hours: false });
    expect(result.legs?.[0]).toMatchObject({ parentOrderId: order.id, type: 'stop', timeInForce: 'day', stopPrice: 98 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('submits a standalone DAY fractional sell stop and validates its tick before networking', async () => {
    const api = new AlpacaApi(credentials);
    await expect(api.submitOrder({ symbol: 'SPY', side: 'sell', qty: .5, type: 'stop', stopPrice: .12345, timeInForce: 'day' })).rejects.toThrow('increments');
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockResolvedValueOnce(response({ ...order, type: 'stop', side: 'sell', qty: '.5', stop_price: '.1234', time_in_force: 'day' }));
    await api.submitOrder({ symbol: 'SPY', side: 'sell', qty: .5, type: 'stop', stopPrice: .1234, timeInForce: 'day' });
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({ type: 'stop', side: 'sell', stop_price: '0.1234', qty: '0.5', time_in_force: 'day', extended_hours: false });
  });

  it('routes paper and live accounts explicitly with credentials in headers only', async () => {
    fetchMock.mockResolvedValueOnce(response(account)).mockResolvedValueOnce(response(account));
    const paper = new AlpacaApi(credentials);
    const live = new AlpacaApi({ ...credentials, environment: 'live' });
    expect(await paper.getAccount()).toMatchObject({ equity: 100100.25, buyingPower: 80000, tradingBlocked: false });
    await live.getAccount();
    expect(fetchMock.mock.calls[0][0]).toBe('https://paper-api.alpaca.markets/v2/account');
    expect(fetchMock.mock.calls[1][0]).toBe('https://api.alpaca.markets/v2/account');
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      method: 'GET', cache: 'no-store', credentials: 'omit', redirect: 'error',
      headers: { 'APCA-API-KEY-ID': credentials.keyId, 'APCA-API-SECRET-KEY': credentials.secretKey },
    });
  });

  it('refuses malformed credentials or an unknown trading environment before networking', () => {
    expect(() => new AlpacaApi({ ...credentials, keyId: '' })).toThrow('Both');
    expect(() => new AlpacaApi({ ...credentials, secretKey: 'a\nb' })).toThrow('line breaks');
    expect(() => new AlpacaApi({ ...credentials, environment: 'other' as 'paper' })).toThrow('paper or live');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('treats account-level restrictions as a trading block', async () => {
    fetchMock.mockResolvedValueOnce(response({ ...account, account_blocked: true }));
    expect((await new AlpacaApi(credentials).getAccount()).tradingBlocked).toBe(true);
  });

  it('uses stable non-secret account identity across key rotation and separates replacements/environments', async () => {
    fetchMock.mockImplementation(async () => response({ ...account, id: 'synthetic-account-1', account_number: 'not-the-identity' }));
    const first = await new AlpacaApi(credentials).getAccount();
    const rotated = await new AlpacaApi({ ...credentials, keyId: 'rotated-example', secretKey: 'rotated-secret-example' }).getAccount();
    const scope = alpacaAccountScope(first, 'paper');
    expect(scope).toEqual({ broker: 'alpaca', accountId: 'synthetic-account-1', environment: 'paper' });
    expect(alpacaAccountScope(rotated, 'paper')).toEqual(scope);
    expect(alpacaAccountScope(first, 'live')).not.toEqual(scope);
    fetchMock.mockResolvedValue(response({ ...account, id: 'synthetic-replacement-account' }));
    expect(alpacaAccountScope(await new AlpacaApi(credentials).getAccount(), 'paper')).not.toEqual(scope);
    const serialized = JSON.stringify({ first, scope });
    for (const forbidden of [credentials.keyId, credentials.secretKey, 'not-the-identity', 'APCA-API', 'secretKey', 'keyId']) expect(serialized).not.toContain(forbidden);
    
  });

  it.each([undefined, null, '', ' ', ' leading-space', 'line\nbreak', 123, {}, 'x'.repeat(201)])('keeps missing/malformed account identity %j unavailable', async id => {
    fetchMock.mockResolvedValue(response({ ...account, id }));
    const normalized = await new AlpacaApi(credentials).getAccount();
    expect(normalized.id).toBeNull();
    expect(() => alpacaAccountScope(normalized, 'paper')).toThrow();
  });

  it.each([
    ['40000.25', 40000.25], [0, 0], ['0', 0], [undefined, null], [null, null], ['', null],
    ['not-a-balance', null], [-1, null], ['Infinity', null],
  ])('maps optional Regulation T buying power %s without inventing available funds', async (value, expected) => {
    fetchMock.mockResolvedValueOnce(response({ ...account, regt_buying_power: value }));
    expect(await new AlpacaApi(credentials).getAccount()).toMatchObject({ buyingPower: 80000, regtBuyingPower: expected });
  });

  it('creates one regular-hours DAY order and never silently converts invalid quantities', async () => {
    fetchMock.mockResolvedValueOnce(response(order));
    const api = new AlpacaApi(credentials);
    const created = await api.submitOrder({ symbol: ' spy ', qty: 2, side: 'buy', type: 'market', clientOrderId: 'terminal-click-1' });
    expect(created).toMatchObject({ id: 'order-123', qty: 2, filledQty: 0, filledAvgPrice: undefined, status: 'accepted' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('https://paper-api.alpaca.markets/v2/orders');
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      symbol: 'SPY', qty: '2', side: 'buy', type: 'market', time_in_force: 'day', extended_hours: false, client_order_id: 'terminal-click-1',
    });
    for (const qty of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(api.submitOrder({ symbol: 'SPY', qty, side: 'buy', type: 'market' })).rejects.toThrow('Quantity');
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('requires a valid limit price and preserves fractional quantities', async () => {
    fetchMock.mockResolvedValueOnce(response({ ...order, type: 'limit', limit_price: '612.35', qty: '0.5' }));
    const api = new AlpacaApi(credentials);
    await expect(api.submitOrder({ symbol: 'SPY', qty: 0.5, side: 'buy', type: 'limit' })).rejects.toThrow('limit price');
    await expect(api.submitOrder({ symbol: 'SPY', qty: 0.5, side: 'buy', type: 'limit', limitPrice: Number.NaN })).rejects.toThrow('limit price');
    await api.submitOrder({ symbol: 'SPY', qty: 0.5, side: 'buy', type: 'limit', limitPrice: 612.35, clientOrderId: 'limit-1' });
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({ qty: '0.5', limit_price: '612.35', type: 'limit' });
  });

  it.each([1.001, 10.009, 0.12345, 0.00001])('rejects unsupported limit increment %s before networking', async limitPrice => {
    await expect(new AlpacaApi(credentials).submitOrder({ symbol: 'SPY', side: 'buy', qty: 1, type: 'limit', limitPrice })).rejects.toThrow('increments');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([1, 1.15, 0.9999, 0.0001])('preserves supported tick %s and explicit extended GTC settings', async limitPrice => {
    fetchMock.mockResolvedValueOnce(response(order));
    await new AlpacaApi(credentials).submitOrder({ symbol: 'SPY', side: 'buy', qty: 1, type: 'limit', limitPrice, timeInForce: 'gtc', extendedHours: true });
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({ limit_price: String(limitPrice), time_in_force: 'gtc', extended_hours: true });
  });

  it('rejects fractional GTC and market extended hours before networking', async () => {
    const api = new AlpacaApi(credentials);
    await expect(api.submitOrder({ symbol: 'SPY', side: 'sell', qty: 1.5, type: 'limit', limitPrice: 1, timeInForce: 'gtc' })).rejects.toThrow('whole shares');
    await expect(api.submitOrder({ symbol: 'SPY', side: 'buy', qty: 1, type: 'market', timeInForce: 'day', extendedHours: true })).rejects.toThrow('limit order');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fetches one tracked order with its client reference and broker fill time', async () => {
    fetchMock.mockResolvedValueOnce(response({
      ...order, client_order_id: 'paca-bot-1-entry', status: 'filled', filled_qty: '2',
      filled_avg_price: '602.10', filled_at: '2026-09-17T14:01:02.345678Z',
      updated_at: '2026-09-17T14:01:03.000000Z',
    }));
    expect(await new AlpacaApi(credentials).getOrder(order.id)).toMatchObject({
      id: order.id, clientOrderId: 'paca-bot-1-entry', status: 'filled', filledQty: 2,
      filledAvgPrice: 602.1, filledAt: '2026-09-17T14:01:02.345678Z',
      updatedAt: '2026-09-17T14:01:03.000000Z',
    });
    expect(fetchMock.mock.calls[0][0]).toBe('https://paper-api.alpaca.markets/v2/orders/order-123?nested=true');
    expect(fetchMock.mock.calls[0][1]?.method).toBe('GET');
  });

  it('looks up the exact client identity without scanning recent orders or retrying', async () => {
    fetchMock.mockResolvedValueOnce(response({ ...order, client_order_id: 'paca-v2-stable' }));
    expect(await new AlpacaApi(credentials).getOrderByClientOrderId('paca-v2-stable')).toMatchObject({ id: order.id, clientOrderId: 'paca-v2-stable' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('https://paper-api.alpaca.markets/v2/orders:by_client_order_id?client_order_id=paca-v2-stable');
    expect(fetchMock.mock.calls[0][1]?.method).toBe('GET');
  });

  it('returns only a 404 lookup as not found, preserving other failures', async () => {
    const api = new AlpacaApi(credentials);
    fetchMock.mockResolvedValueOnce(response({}, 404)).mockResolvedValueOnce(response({}, 500)).mockResolvedValueOnce(response({}, 500)).mockResolvedValueOnce(response({}, 403));
    expect(await api.getOrderByClientOrderId('stable')).toBeNull();
    const missing = expect(api.getOrderByClientOrderId('stable')).rejects.toMatchObject({ status: 500 });
    await vi.advanceTimersByTimeAsync(1000); await missing;
    await expect(api.getOrderByClientOrderId('stable')).rejects.toMatchObject({ status: 403 });
    await expect(api.getOrderByClientOrderId('bad/id')).rejects.toThrow('reference');
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it.each([null, undefined, 'not-a-time'])('keeps pending cancellation and an unavailable fill time (%s) explicit', async filledAt => {
    fetchMock.mockResolvedValueOnce(response({ ...order, status: 'pending_cancel', filled_qty: '0.5', filled_at: filledAt }));
    expect(await new AlpacaApi(credentials).getOrder(order.id)).toMatchObject({
      status: 'pending_cancel', filledQty: 0.5, filledAt: null, clientOrderId: undefined,
    });
  });

  it('rejects invalid tracked-order IDs and mismatched broker responses', async () => {
    const api = new AlpacaApi(credentials);
    await expect(api.getOrder('../account')).rejects.toThrow('order ID is invalid');
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockResolvedValueOnce(response({ ...order, id: 'another-order' }));
    await expect(api.getOrder(order.id)).rejects.toThrow('different order');
  });

  it('enables 24/5 execution only for explicitly extended-hours limit orders', async () => {
    fetchMock.mockResolvedValueOnce(response({ ...order, type: 'limit', limit_price: '612.35' }));
    const api = new AlpacaApi(credentials);
    await expect(api.submitOrder({ symbol: 'SPY', qty: 2, side: 'buy', type: 'market', extendedHours: true })).rejects.toThrow('requires a limit order');
    expect(fetchMock).not.toHaveBeenCalled();
    await api.submitOrder({ symbol: 'SPY', qty: 2, side: 'buy', type: 'limit', limitPrice: 612.35, extendedHours: true });
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({
      type: 'limit', time_in_force: 'day', extended_hours: true, limit_price: '612.35',
    });
  });

  it('redacts credentials from API errors and does not retry rejected orders', async () => {
    fetchMock.mockResolvedValueOnce(response({ message: `rejected ${credentials.keyId} ${credentials.secretKey}` }, 422));
    const api = new AlpacaApi(credentials);
    const error = await api.submitOrder({ symbol: 'SPY', qty: 2, side: 'buy', type: 'market', clientOrderId: 'reject-1' }).catch(value => value);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain('422');
    expect(error.message).not.toContain(credentials.keyId);
    expect(error.message).not.toContain(credentials.secretKey);
    expect(error).toMatchObject({ executionUncertain: false, retryAfterMs: undefined });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['12', 12_000], ['0', 0], ['Thu, 17 Sep 2026 14:02:00 GMT', 120_000],
    [undefined, 60_000], ['', 60_000], ['invalid', 60_000], ['-1', 60_000],
    ['Thu, 17 Sep 2026 13:59:00 GMT', 60_000], ['99999999999999999999999', 60_000],
  ])('retains rate-limit delay metadata for Retry-After %s without retrying in the adapter', async (header, expected) => {
    const rejected = response({ message: `rejected ${credentials.secretKey}` }, 429);
    if (header !== undefined) rejected.headers.set('Retry-After', header);
    fetchMock.mockResolvedValueOnce(rejected);
    const error = await new AlpacaApi(credentials).submitOrder({ symbol: 'SPY', qty: 1, side: 'sell', type: 'market' }).catch(value => value);
    expect(error).toBeInstanceOf(AlpacaRequestError);
    expect(error).toMatchObject({ executionUncertain: false, retryAfterMs: expected });
    expect(error.message).not.toContain(credentials.secretKey);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([170, 300])('preserves execution uncertainty when a %i-character server detail truncates the warning', async size => {
    const unavailable = response({ message: 'x'.repeat(size) }, 500);
    unavailable.headers.set('Retry-After', '12');
    fetchMock.mockResolvedValueOnce(unavailable);
    const error = await new AlpacaApi(credentials).submitOrder({ symbol: 'SPY', qty: 1, side: 'buy', type: 'market' }).catch(value => value);
    expect(error).toBeInstanceOf(AlpacaRequestError);
    expect(error.executionUncertain).toBe(true);
    expect(error.retryAfterMs).toBeUndefined();
    expect(error.message.length).toBeLessThanOrEqual(260);
    expect(error.message).toContain('Outcome uncertain');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps failed reads and definite order rejections distinct from uncertain writes', async () => {
    fetchMock.mockResolvedValueOnce(response({ message: 'unknown account state' }, 500)).mockResolvedValueOnce(response({ message: 'unknown account state' }, 500))
      .mockResolvedValueOnce(response({ message: 'incomplete order fields' }, 422));
    const api = new AlpacaApi(credentials);
    const reading = expect(api.getAccount()).rejects.toMatchObject({ executionUncertain: false });
    await vi.advanceTimersByTimeAsync(1000); await reading;
    await expect(api.submitOrder({ symbol: 'SPY', qty: 1, side: 'buy', type: 'market' })).rejects.toMatchObject({ executionUncertain: false });
  });

  it.each([408, 500, 502, 504])('HTTP %s cannot establish definite nonacceptance of a submission', async status => {
    fetchMock.mockResolvedValueOnce(response({ message: 'Synthetic timeout or server failure' }, status));
    await expect(new AlpacaApi(credentials).submitOrder({ symbol: 'SPY', qty: 1, side: 'buy', type: 'market' }))
      .rejects.toMatchObject({ executionUncertain: true, status });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('marks unreadable or incomplete successful order and exit responses uncertain', async () => {
    const api = new AlpacaApi(credentials);
    for (const action of [() => api.submitOrder({ symbol: 'SPY', qty: 1, side: 'buy', type: 'market' }), () => api.submitOrder({ symbol: 'SPY', qty: 1, side: 'sell', type: 'market' })]) {
      for (const result of [new Response('not JSON'), response({ id: 'accepted-but-incomplete' }), new Response(null, { status: 204 })]) {
        fetchMock.mockResolvedValueOnce(result);
        await expect(action()).rejects.toMatchObject({ executionUncertain: true, retryAfterMs: undefined });
      }
    }
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it.each([new TypeError('Failed to fetch'), new Error('Transport failed'), new DOMException('Connection aborted', 'AbortError')])('marks transport failures uncertain without retrying writes: %s', async error => {
    fetchMock.mockRejectedValueOnce(error);
    await expect(new AlpacaApi(credentials).cancelOrder('order-123')).rejects.toMatchObject({ executionUncertain: true, retryAfterMs: undefined });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('flags an unknown order outcome after a network failure without retrying', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(new AlpacaApi(credentials).submitOrder({ symbol: 'SPY', qty: 1, side: 'sell', type: 'market' })).rejects.toThrow('Reconcile orders before any new action');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('times out stalled requests and explains that a mutation may have reached Alpaca', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementationOnce((_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    }));
    const pending = new AlpacaApi(credentials).submitOrder({ symbol: 'SPY', qty: 1, side: 'sell', type: 'market' });
    const assertion = expect(pending).rejects.toMatchObject({ executionUncertain: true, retryAfterMs: undefined, message: expect.stringContaining('Reconcile orders before any new action') });
    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not mark a known rejection uncertain when reading its body times out', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementationOnce(async (_input, init) => {
      const rejected = response({}, 422);
      vi.spyOn(rejected, 'json').mockImplementationOnce(() => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      }));
      return rejected;
    });
    const assertion = expect(new AlpacaApi(credentials).submitOrder({ symbol: 'SPY', qty: 1, side: 'sell', type: 'market' })).rejects.toMatchObject({ executionUncertain: false });
    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('preserves the retry delay when a rate-limit rejection body times out', async () => {
    fetchMock.mockImplementationOnce(async (_input, init) => {
      const rejected = response({}, 429);
      rejected.headers.set('Retry-After', '30');
      vi.spyOn(rejected, 'json').mockImplementationOnce(() => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      }));
      return rejected;
    });
    const assertion = expect(new AlpacaApi(credentials).submitOrder({ symbol: 'SPY', qty: 1, side: 'sell', type: 'market' })).rejects.toMatchObject({
      executionUncertain: false, retryAfterMs: 30_000, message: expect.stringContaining('timed out'),
    });
    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('cancels only the explicitly identified order', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await new AlpacaApi(credentials).cancelOrder('order-123');
    expect(fetchMock.mock.calls[0][0]).toBe('https://paper-api.alpaca.markets/v2/orders/order-123');
    expect(fetchMock.mock.calls[0][1]?.method).toBe('DELETE');
    expect(fetchMock.mock.calls[0][1]?.body).toBeUndefined();
  });

  it('preserves external stop-order types when listing recent orders', async () => {
    fetchMock.mockResolvedValueOnce(response([{ ...order, type: 'trailing_stop', status: 'new' }])).mockResolvedValueOnce(response([]));
    expect((await new AlpacaApi(credentials).getOrders())[0].type).toBe('trailing_stop');
    expect(String(fetchMock.mock.calls[0][0])).toContain('status=open');
    expect(String(fetchMock.mock.calls[1][0])).toContain('status=closed');
  });

  it('keeps an old open order visible ahead of recent filled orders, without duplicate IDs', async () => {
    const oldOpen = { ...order, id: 'old-open', submitted_at: '2025-01-01T14:00:00Z' };
    fetchMock.mockResolvedValueOnce(response([oldOpen])).mockResolvedValueOnce(response([{ ...order, id: 'recent-filled', status: 'filled' }, { ...oldOpen, status: 'filled' }]));
    expect((await new AlpacaApi(credentials).getOrders()).map(item => [item.id, item.status])).toEqual([
      ['old-open', 'accepted'], ['recent-filled', 'filled'],
    ]);
  });

  it('loads attached stops in the order batch while preserving flat account conflict coverage', async () => {
    const stop = { ...order, id: 'attached-stop', side: 'sell', type: 'stop', status: 'new', stop_price: '98', time_in_force: 'gtc' };
    const parent = { ...order, order_class: 'oto', status: 'filled', filled_qty: '2', legs: [stop] };
    fetchMock.mockResolvedValueOnce(response([stop])).mockResolvedValueOnce(response([parent]));
    const orders = await new AlpacaApi(credentials).getOrders();
    expect(orders.map(order => order.id)).toEqual(['attached-stop', 'order-123']);
    expect(orders[1].legs?.[0]).toMatchObject({ id: 'attached-stop', parentOrderId: 'order-123', stopPrice: 98 });
    expect(fetchMock.mock.calls.every(([url]) => new URL(String(url)).searchParams.get('nested') === 'true')).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('imports individual partial fills without imposing a history start date', async () => {
    fetchMock.mockResolvedValueOnce(response([fill, { ...fill, id: '20260917135900000::fill-2', qty: '1.5', price: '602.10', type: 'fill', transaction_time: '2026-09-17T13:59:00.000Z' }]));
    const page = await new AlpacaApi(credentials).getTradeActivities();
    expect(page.activities).toEqual([
      { id: fill.id, orderId: 'order-123', symbol: 'SPY', side: 'buy', qty: 0.5, price: 602.25, transactionTime: fill.transaction_time, type: 'partial_fill' },
      { id: '20260917135900000::fill-2', orderId: 'order-123', symbol: 'SPY', side: 'buy', qty: 1.5, price: 602.1, transactionTime: '2026-09-17T13:59:00.000Z', type: 'fill' },
    ]);
    expect(page.nextPageToken).toBeNull();
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.pathname).toBe('/v2/account/activities/FILL');
    expect(Object.fromEntries(url.searchParams)).toEqual({ page_size: '100', direction: 'desc' });
  });

  it('uses the final activity ID to page beyond the first hundred fills and preserves incremental filters', async () => {
    const fills = Array.from({ length: 100 }, (_, index) => ({ ...fill, id: `20260917140000000::fill-${index}` }));
    fetchMock.mockResolvedValueOnce(response(fills)).mockResolvedValueOnce(response([{ ...fill, id: '20260916140000000::older', side: 'sell' }])).mockResolvedValueOnce(response([]));
    const api = new AlpacaApi(credentials);
    const after = '2026-09-01T00:00:00-04:00';
    const first = await api.getTradeActivities({ after });
    expect(first.nextPageToken).toBe(fills[99].id);
    const second = await api.getTradeActivities({ after, pageToken: first.nextPageToken! });
    expect(second.activities[0].side).toBe('sell');
    expect(second.nextPageToken).toBeNull();
    const nextUrl = new URL(String(fetchMock.mock.calls[1][0]));
    expect(nextUrl.searchParams.get('page_token')).toBe(fills[99].id);
    expect(nextUrl.searchParams.get('after')).toBe(after);
    expect(await api.getTradeActivities()).toEqual({ activities: [], nextPageToken: null });
  });

  it('rejects malformed fill data rather than substituting quantities, prices, times, or sides', async () => {
    const api = new AlpacaApi(credentials);
    for (const change of [{ price: null }, { qty: 0 }, { price: -1 }, { transaction_time: 'not-a-time' }, { order_id: null }, { symbol: '' }, { side: 'short' }, { activity_type: 'DIV' }, { type: undefined }]) {
      fetchMock.mockResolvedValueOnce(response([{ ...fill, ...change }]));
      await expect(api.getTradeActivities()).rejects.toThrow('incomplete trade activity');
    }
    fetchMock.mockResolvedValueOnce(response({ activities: [fill] }));
    await expect(api.getTradeActivities()).rejects.toThrow('invalid trade history page');
  });

  it('rejects repeated fill IDs and invalid pagination inputs instead of looping or truncating silently', async () => {
    const api = new AlpacaApi(credentials);
    await expect(api.getTradeActivities({ after: 'invalid' })).rejects.toThrow('start date');
    await expect(api.getTradeActivities({ pageToken: '' })).rejects.toThrow('page token');
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockResolvedValueOnce(response([fill, fill])).mockResolvedValueOnce(response([fill]));
    await expect(api.getTradeActivities()).rejects.toThrow('repeated trade history cursor');
    await expect(api.getTradeActivities({ pageToken: fill.id })).rejects.toThrow('repeated trade history cursor');
  });

  it('fails closed if the open-order result reaches the API cap', async () => {
    fetchMock.mockResolvedValueOnce(response(Array.from({ length: 500 }, (_, index) => ({ ...order, id: `open-${index}` })))).mockResolvedValueOnce(response([]));
    await expect(new AlpacaApi(credentials).getOrders()).rejects.toThrow('complete safety check');
  });

  it('rejects incomplete account balances instead of substituting a fictitious baseline', async () => {
    fetchMock.mockResolvedValueOnce(response({ ...account, last_equity: null }));
    await expect(new AlpacaApi(credentials).getAccount()).rejects.toThrow('incomplete account data');
  });

  it('rejects incomplete positions instead of hiding holdings from the robot', async () => {
    fetchMock.mockResolvedValueOnce(response([{ qty: '5', avg_entry_price: '600', side: 'long' }]));
    await expect(new AlpacaApi(credentials).getPositions()).rejects.toThrow('incomplete position data');
  });

  it('preserves unavailable account and position metrics as null while retaining reported zero', async () => {
    fetchMock.mockResolvedValueOnce(response({ ...account, portfolio_value: undefined, daytrade_count: undefined }))
      .mockResolvedValueOnce(response([{ symbol: 'SPY', qty: '5', avg_entry_price: '600', side: 'long', current_price: null, market_value: 'invalid', unrealized_pl: '0' }]));
    const api = new AlpacaApi(credentials);
    expect(await api.getAccount()).toMatchObject({ equity: 100100.25, portfolioValue: null, daytradeCount: null });
    expect(await api.getPositions()).toEqual([{
      symbol: 'SPY', qty: 5, avgEntryPrice: 600, side: 'long', currentPrice: null, marketValue: null, unrealizedPl: 0, unrealizedPlpc: null,
    }]);
  });

  it('does not invent quantity or fill price for external notional orders', async () => {
    fetchMock.mockResolvedValueOnce(response([{ ...order, qty: null, filled_qty: undefined, filled_avg_price: 'invalid', limit_price: false }]))
      .mockResolvedValueOnce(response([]));
    expect((await new AlpacaApi(credentials).getOrders())[0]).toMatchObject({ qty: null, filledQty: null, filledAvgPrice: undefined, limitPrice: undefined });
  });

  it('loads SIP snapshots on the data host and omits missing or unpriced symbols', async () => {
    fetchMock.mockResolvedValueOnce(response({
      SPY: {
        latestTrade: { p: 605, t: '2026-09-17T14:31:30Z' }, latestQuote: { bp: 604.99, ap: 605.01 },
        dailyBar: { c: 605, h: 608, l: 599, v: 42000, t: '2026-09-17T04:00:00Z' }, prevDailyBar: { c: 600 },
      }, MISSING: null,
    }));
    const snapshots = await new AlpacaApi(credentials).getSnapshots(['SPY', 'MISSING', 'SPY']);
    expect(Object.keys(snapshots)).toEqual(['SPY']);
    expect(snapshots.SPY).toMatchObject({ price: 605, previousClose: 600, change: 5, bid: 604.99, ask: 605.01, timestamp: '2026-09-17T14:31:30Z' });
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.origin).toBe('https://data.alpaca.markets');
    expect(url.searchParams.get('feed')).toBe('sip');
    expect(url.searchParams.get('symbols')).toBe('SPY,MISSING');
  });

  it('switches SIP snapshots to BOATS during the overnight session', async () => {
    vi.setSystemTime(new Date('2026-09-20T20:30:00-04:00'));
    fetchMock.mockResolvedValueOnce(response({
      SPY: { latestTrade: { p: 605, t: '2026-09-21T00:15:00Z' }, latestQuote: { bp: 604.99, ap: 605.01 } },
    }));
    const snapshots = await new AlpacaApi(credentials).getSnapshots(['SPY']);
    expect(snapshots.SPY).toMatchObject({ price: 605, timestamp: '2026-09-21T00:15:00Z', bid: 604.99, ask: 605.01 });
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.pathname).toBe('/v2/stocks/snapshots');
    expect(url.searchParams.get('feed')).toBe('boats');
  });

  it('uses SIP snapshots again at 04:00 ET and during the weekend', async () => {
    const api = new AlpacaApi(credentials);
    fetchMock.mockImplementation(async () => response({}));
    for (const time of ['2026-09-21T04:00:00-04:00', '2026-09-18T20:00:00-04:00']) {
      vi.setSystemTime(new Date(time));
      await api.getSnapshots(['SPY']);
      expect(new URL(String(fetchMock.mock.calls.at(-1)![0])).searchParams.get('feed')).toBe('sip');
    }
  });

  it('keeps missing quote metrics unavailable instead of creating zero changes or price ranges', async () => {
    fetchMock.mockResolvedValueOnce(response({
      SPY: { latestTrade: { p: 605, t: '2026-09-17T14:31:30Z' }, latestQuote: { bp: 0, ap: 'invalid' }, dailyBar: { v: null }, prevDailyBar: null },
    }));
    expect((await new AlpacaApi(credentials).getSnapshots(['SPY'])).SPY).toEqual({
      symbol: 'SPY', price: 605, timestamp: '2026-09-17T14:31:30Z', previousClose: null, change: null, changePercent: null,
      bid: null, ask: null, volume: null, high: null, low: null,
    });
  });

  it('preserves actual zero changes and volume when supplied by Alpaca', async () => {
    fetchMock.mockResolvedValueOnce(response({
      SPY: { latestTrade: { p: '605', t: '2026-09-17T14:31:30Z' }, dailyBar: { v: 0 }, prevDailyBar: { c: '605' } },
    }));
    expect((await new AlpacaApi(credentials).getSnapshots(['SPY'])).SPY).toMatchObject({ price: 605, previousClose: 605, change: 0, changePercent: 0, volume: 0, high: null, low: null });
  });

  it('omits invalid snapshot prices and timestamps instead of replacing them with another value', async () => {
    fetchMock.mockResolvedValueOnce(response({
      SPY: { latestTrade: { p: true, t: '2026-09-17T14:31:30Z' } },
      QQQ: { latestTrade: { p: 605, t: 'invalid' } },
    }));
    expect(await new AlpacaApi(credentials).getSnapshots(['SPY', 'QQQ'])).toEqual({});
  });

  it('pages descending bars, deduplicates timestamps, and returns chart data in time order', async () => {
    const bar = (t: string, c: number) => ({ t, o: c, h: c + 1, l: c - 1, c, v: 100 });
    fetchMock.mockResolvedValueOnce(response({ bars: [bar('2026-09-17T14:02:00Z', 602), bar('2026-09-17T14:01:00Z', 601)], next_page_token: 'page-2' }))
      .mockResolvedValueOnce(response({ bars: [bar('2026-09-17T14:01:00Z', 601), bar('2026-09-17T14:00:00Z', 600)], next_page_token: null }));
    const bars = await new AlpacaApi(credentials).getBars('SPY', '1Min');
    expect(bars.map(item => item.c)).toEqual([600, 601, 602]);
    const firstUrl = new URL(String(fetchMock.mock.calls[0][0]));
    expect(firstUrl.searchParams.get('sort')).toBe('desc');
    expect(firstUrl.searchParams.get('feed')).toBe('sip');
    expect(firstUrl.searchParams.get('limit')).toBe('400');
    expect(new URL(String(fetchMock.mock.calls[1][0])).searchParams.get('page_token')).toBe('page-2');
  });

  it('loads up to 10,000 chart candles across more than ten short pages', async () => {
    const candles = Array.from({ length: 10_050 }, (_, index) => ({
      t: new Date(Date.now() - (10_050 - index) * 15 * 60_000).toISOString(), o: 500, h: 501, l: 499, c: 500, v: index,
    })).reverse();
    fetchMock.mockImplementation(async input => {
      const page = Number(new URL(String(input)).searchParams.get('page_token') ?? 0);
      return response({ bars: candles.slice(page * 900, (page + 1) * 900), next_page_token: String(page + 1) });
    });
    const bars = await new AlpacaApi(credentials).getBars('SPY', '15Min', { extendedHistory: true });
    expect(bars).toHaveLength(10_000);
    expect([bars[0].v, bars.at(-1)!.v]).toEqual([50, 10_049]);
    expect(fetchMock).toHaveBeenCalledTimes(12);
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.searchParams.get('limit')).toBe('10000');
    expect(Date.now() - Date.parse(url.searchParams.get('start')!)).toBe(365 * 86_400_000);
  });

  it.each([['1Min', 60], ['5Min', 180], ['1Hour', 1095], ['1Day', 7300], ['1Week', 7300]] as const)(
    'requests the broader %s chart history window', async (timeframe, days) => {
      fetchMock.mockResolvedValueOnce(response({ bars: [], next_page_token: null }));
      await new AlpacaApi(credentials).getBars('SPY', timeframe, { extendedHistory: true });
      const url = new URL(String(fetchMock.mock.calls[0][0]));
      expect(Date.now() - Date.parse(url.searchParams.get('start')!)).toBe(days * 86_400_000);
    },
  );

  it('refreshes chart history with overlapping candles, preserving older history and replacing revisions', async () => {
    const bar = (t: string, c: number) => ({ t, o: c, h: c + 1, l: c - 1, c, v: 100 });
    const oldest = bar('2026-01-02T14:00:00Z', 500), previous = bar('2026-09-16T14:00:00Z', 600), latest = bar('2026-09-16T14:15:00Z', 601);
    fetchMock.mockResolvedValueOnce(response({ bars: [latest, previous, oldest], next_page_token: null }))
      .mockResolvedValueOnce(response({ bars: [bar('2026-09-17T14:00:00Z', 603), { ...latest, c: 602 }], next_page_token: null }));
    const broker = new AlpacaApi(credentials), api = new ChartHistory(broker.getBars.bind(broker));
    await api.getBars('SPY', '15Min', { extendedHistory: true });
    vi.setSystemTime(Date.now() + 30_000);
    const bars = await api.getBars('SPY', '15Min', { extendedHistory: true });
    expect(bars.map(item => item.c)).toEqual([500, 600, 602, 603]);
    const url = new URL(String(fetchMock.mock.calls[1][0]));
    expect(Date.parse(url.searchParams.get('start')!)).toBe(Date.parse(previous.t));
  });

  it('periodically reloads all chart history despite intervening refreshes to pick up split adjustments', async () => {
    const initial = Date.now();
    const bar = (t: string, c: number) => ({ t, o: c, h: c + 1, l: c - 1, c, v: 100 });
    const oldest = bar('2026-01-02T14:00:00Z', 500), latest = bar('2026-09-17T13:45:00Z', 600);
    fetchMock.mockResolvedValueOnce(response({ bars: [latest, oldest], next_page_token: null }))
      .mockResolvedValueOnce(response({ bars: [latest], next_page_token: null }))
      .mockResolvedValueOnce(response({ bars: [bar(latest.t, 300), bar(oldest.t, 250)], next_page_token: null }));
    const broker = new AlpacaApi(credentials), api = new ChartHistory(broker.getBars.bind(broker));
    await api.getBars('SPY', '15Min', { extendedHistory: true });
    vi.setSystemTime(initial + 10 * 60_000);
    await api.getBars('SPY', '15Min', { extendedHistory: true });
    vi.setSystemTime(initial + 15 * 60_000);
    expect((await api.getBars('SPY', '15Min', { extendedHistory: true })).map(item => item.c)).toEqual([250, 300]);
    const url = new URL(String(fetchMock.mock.calls[2][0]));
    expect(Date.now() - Date.parse(url.searchParams.get('start')!)).toBe(365 * 86_400_000);
  });

  it('shares in-flight chart loads and retries failed refreshes without losing cached history', async () => {
    const bar = (t: string, c: number) => ({ t, o: c, h: c + 1, l: c - 1, c, v: 100 });
    const oldest = bar('2026-01-02T14:00:00Z', 500), previous = bar('2026-09-17T13:30:00Z', 600), latest = bar('2026-09-17T13:45:00Z', 601);
    let resolveFetch!: (value: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>(resolve => { resolveFetch = resolve; }))
      .mockResolvedValueOnce(response({ message: 'Read denied' }, 403))
      .mockResolvedValueOnce(response({ bars: [bar('2026-09-17T14:00:00Z', 602)], next_page_token: null }));
    const broker = new AlpacaApi(credentials), api = new ChartHistory(broker.getBars.bind(broker));
    const first = api.getBars('SPY', '15Min', { extendedHistory: true });
    const second = api.getBars(' spy ', '15Min', { extendedHistory: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    resolveFetch(response({ bars: [latest, previous, oldest], next_page_token: null }));
    expect(await first).toEqual(await second);
    await expect(api.getBars('SPY', '15Min', { extendedHistory: true })).rejects.toThrow();
    expect((await api.getBars('SPY', '15Min', { extendedHistory: true })).map(item => item.c)).toEqual([500, 600, 601, 602]);
    expect(Date.parse(new URL(String(fetchMock.mock.calls[2][0])).searchParams.get('start')!)).toBe(Date.parse(previous.t));
    api.dispose();
    await expect(api.getBars('SPY', '15Min', { extendedHistory: true })).rejects.toThrow('closed');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('expires chart candles outside the rolling lookback and bounds the history cache', async () => {
    const initial = Date.now();
    const makeBars = () => [initial - 60_000, initial - 120_000, initial - 60 * 86_400_000 + 1000].map(time => ({ t: new Date(time).toISOString(), o: 500, h: 501, l: 499, c: 500, v: 100 }));
    fetchMock.mockImplementation(async input => response({ bars: new URL(String(input)).searchParams.get('start') === new Date(initial - 120_000).toISOString() ? [] : makeBars(), next_page_token: null }));
    const broker = new AlpacaApi(credentials), api = new ChartHistory(broker.getBars.bind(broker));
    await api.getBars('SPY', '1Min', { extendedHistory: true });
    vi.setSystemTime(initial + 2000);
    expect(await api.getBars('SPY', '1Min', { extendedHistory: true })).toHaveLength(2);
    for (const ticker of ['AAA', 'AAB', 'AAC', 'AAD', 'AAE', 'AAF', 'AAG', 'AAH', 'AAI', 'AAJ', 'AAK', 'AAL']) {
      await api.getBars(ticker, '1Min', { extendedHistory: true });
    }
    await api.getBars('SPY', '1Min', { extendedHistory: true });
    const url = new URL(String(fetchMock.mock.calls.at(-1)![0]));
    expect(Date.now() - Date.parse(url.searchParams.get('start')!)).toBe(60 * 86_400_000);
  });

  it.each(['repeated', 'unbounded'] as const)('rejects %s chart pagination instead of silently truncating it', async kind => {
    fetchMock.mockImplementation(async () => response({ bars: [], next_page_token: kind === 'repeated' ? 'again' : String(fetchMock.mock.calls.length) }));
    await expect(new AlpacaApi(credentials).getBars('SPY', '15Min', { extendedHistory: true })).rejects.toThrow(kind === 'repeated' ? 'repeated' : 'paging limit');
    expect(fetchMock).toHaveBeenCalledTimes(kind === 'repeated' ? 2 : 100);
  });

  it('keeps the newest 10,000 chart candles after merging separate daytime and overnight histories', async () => {
    vi.setSystemTime(new Date('2026-09-21T02:00:00Z'));
    const bar = (index: number, c = 500) => ({ t: new Date(Date.now() - (13_000 - index) * 15 * 60_000).toISOString(), o: c, h: c + 1, l: c - 1, c, v: index });
    fetchMock.mockImplementation(async input => response({
      bars: new URL(String(input)).searchParams.get('feed') === 'boats'
        ? Array.from({ length: 8000 }, (_, index) => bar(index + 5000, 600))
        : Array.from({ length: 6000 }, (_, index) => bar(index)),
      next_page_token: null,
    }));
    const bars = await new AlpacaApi(credentials).getBars('SPY', '15Min', { extendedHistory: true });
    expect(bars).toHaveLength(10_000);
    expect([bars[0].v, bars.at(-1)!.v]).toEqual([3000, 12_999]);
    expect(bars.find(item => item.v === 5500)?.c).toBe(600);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('merges paginated daytime and overnight chart history without duplicate timestamps', async () => {
    vi.setSystemTime(new Date('2026-09-21T02:00:00Z'));
    const bar = (t: string, c: number) => ({ t, o: c, h: c + 1, l: c - 1, c, v: 100 });
    fetchMock.mockImplementation(async input => {
      const url = new URL(String(input)), overnight = url.searchParams.get('feed') === 'boats';
      if (url.searchParams.has('page_token')) {
        return response({ bars: [bar(overnight ? '2026-09-21T00:00:00Z' : '2026-09-18T19:00:00Z', overnight ? 604 : 600)], next_page_token: null });
      }
      return response({
        bars: overnight
          ? [bar('2026-09-21T01:00:00Z', 605), bar('2026-09-21T00:00:00Z', 603)]
          : [bar('2026-09-21T00:00:00Z', 602), bar('2026-09-18T20:00:00Z', 601)],
        next_page_token: overnight ? 'overnight-page-2' : 'daytime-page-2',
      });
    });
    const bars = await new AlpacaApi(credentials).getBars(' spy ', '1Hour');
    expect(bars.map(item => item.c)).toEqual([600, 601, 604, 605]);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    const urls = fetchMock.mock.calls.map(([input]) => new URL(String(input)));
    expect(urls.every(url => url.pathname === '/v2/stocks/SPY/bars')).toBe(true);
    expect(new Set(urls.map(url => url.searchParams.get('start'))).size).toBe(1);
    expect(urls.filter(url => url.searchParams.get('feed') === 'boats').map(url => url.searchParams.get('page_token'))).toEqual([null, 'overnight-page-2']);
    expect(urls.filter(url => url.searchParams.get('feed') === 'sip').map(url => url.searchParams.get('page_token'))).toEqual([null, 'daytime-page-2']);
  });

  it('requests real-time BOATS chart history without a delay', async () => {
    vi.setSystemTime(new Date('2026-09-21T02:00:00Z'));
    fetchMock.mockImplementation(async () => response({ bars: [], next_page_token: null }));
    await new AlpacaApi(credentials).getBars('SPY', '5Min');
    const urls = fetchMock.mock.calls.map(([input]) => new URL(String(input)));
    expect(urls.map(url => url.searchParams.get('feed'))).toEqual(['sip', 'boats']);
    expect(Date.parse(urls[1].searchParams.get('end')!)).toBe(Date.now());
    expect(urls[1].searchParams.get('start')).toBe(urls[0].searchParams.get('start'));
  });

  it('includes last-night BOATS history in a bounded watchlist request during daytime', async () => {
    vi.setSystemTime(new Date('2026-09-17T14:00:00Z'));
    const start = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
    const bar = (t: string, c: number) => ({ t, o: c, h: c, l: c, c, v: 100 });
    fetchMock.mockImplementation(async input => response({ bars: new URL(String(input)).searchParams.get('feed') === 'boats'
      ? [bar('2026-09-17T02:00:00Z', 101)] : [bar('2026-09-17T13:50:00Z', 102), bar('2026-09-16T15:00:00Z', 100)] }));
    const bars = await new AlpacaApi(credentials).getBars('SPY', '5Min', { start, includeOvernight: true });
    expect(bars.map(bar => bar.c)).toEqual([100, 101, 102]);
    const urls = fetchMock.mock.calls.map(([input]) => new URL(String(input)));
    expect(urls.map(url => url.searchParams.get('feed'))).toEqual(['sip', 'boats']);
    expect(urls.every(url => url.searchParams.get('start') === start && url.searchParams.get('timeframe') === '5Min')).toBe(true);
  });

  it('keeps the newest 400 valid candles after merging overnight chart history', async () => {
    vi.setSystemTime(new Date('2026-09-21T02:00:00Z'));
    const bar = (index: number) => ({ t: new Date(Date.now() - (600 - index) * 60_000).toISOString(), o: 500, h: 501, l: 499, c: 500, v: index });
    const older = Array.from({ length: 300 }, (_, index) => bar(index));
    const newer = Array.from({ length: 300 }, (_, index) => bar(index + 300));
    fetchMock.mockImplementation(async input => response({
      bars: new URL(String(input)).searchParams.get('feed') === 'boats'
        ? [...newer, { ...bar(601), v: null }] : older,
      next_page_token: null,
    }));
    const bars = await new AlpacaApi(credentials).getBars('SPY', '1Min');
    expect(bars).toHaveLength(400);
    expect(bars[0].v).toBe(200);
    expect(bars.at(-1)!.v).toBe(599);
  });

  it.each(['1Day', '1Week'] as const)('retains %s daytime candle semantics during overnight trading', async timeframe => {
    vi.setSystemTime(new Date('2026-09-21T02:00:00Z'));
    fetchMock.mockResolvedValue(response({ bars: [], next_page_token: null }));
    await new AlpacaApi(credentials).getBars('SPY', timeframe);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(new URL(String(fetchMock.mock.calls[0][0])).searchParams.get('feed')).toBe('sip');
  });

  it('surfaces overnight history access errors rather than returning only daytime candles', async () => {
    vi.setSystemTime(new Date('2026-09-21T02:00:00Z'));
    fetchMock.mockImplementation(async input => new URL(String(input)).searchParams.get('feed') === 'boats'
      ? response({ message: 'Overnight data unavailable' }, 403)
      : response({ bars: [], next_page_token: null }));
    await expect(new AlpacaApi(credentials).getBars('SPY', '5Min')).rejects.toThrow('Access denied');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('requests native weekly candles with enough history for the chart and indicator warmup', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-17T14:00:00Z'));
    const bar = { t: '2026-09-14T04:00:00Z', o: 600, h: 620, l: 595, c: 615, v: 500000 };
    fetchMock.mockResolvedValueOnce(response({ bars: [bar], next_page_token: null }));
    expect(await new AlpacaApi(credentials).getBars('SPY', '1Week')).toEqual([bar]);
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.pathname).toBe('/v2/stocks/SPY/bars');
    expect(url.searchParams.get('timeframe')).toBe('1Week');
    expect(Date.now() - Date.parse(url.searchParams.get('start')!)).toBeGreaterThanOrEqual(400 * 7 * 86400000);
    expect(url.searchParams.get('adjustment')).toBe('split');
    expect(url.searchParams.get('feed')).toBe('sip');
  });

  it('skips incomplete or inconsistent candles rather than generating OHLC or volume', async () => {
    const valid = { t: '2026-09-17T14:04:00Z', o: 600, h: 602, l: 599, c: 601, v: 0 };
    fetchMock.mockResolvedValueOnce(response({ bars: [
      valid,
      { ...valid, t: '2026-09-17T14:03:00Z', o: undefined },
      { ...valid, t: '2026-09-17T14:02:00Z', v: undefined },
      { ...valid, t: '2026-09-17T14:01:00Z', h: 598 },
      { ...valid, t: '2026-09-17T14:00:00Z', l: null },
    ], next_page_token: null }));
    expect(await new AlpacaApi(credentials).getBars('SPY', '1Min')).toEqual([valid]);
  });

  it('requests cumulative weekly P&L and skips null slots without misaligning arrays', async () => {
    fetchMock.mockResolvedValueOnce(response({ timestamp: [1000, 2000, 3000], equity: [10000, null, 10100], profit_loss: [0, null, 100], profit_loss_pct: [0, null, 0.01], base_value: 10000 }));
    const history = await new AlpacaApi(credentials).getPortfolioHistory('1W');
    expect(history).toEqual({ timestamp: [1000, 3000], equity: [10000, 10100], profitLoss: [0, 100], profitLossPct: [0, 0.01], baseValue: 10000 });
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.searchParams.get('timeframe')).toBe('5Min');
    expect(url.searchParams.get('pnl_reset')).toBe('no_reset');
  });

  it.each(['1D', '1W', '1M', 'ALL'] as const)('excludes signed cash transfers from %s P&L and percentages while retaining investment income', async period => {
    const api = new AlpacaApi(credentials);
    fetchMock.mockResolvedValueOnce(response(account));
    await api.getAccount();
    fetchMock.mockResolvedValueOnce(response({
      timestamp: [1000, 2000, 3000, 4000, 5000],
      equity: [10050, 15125, 13100, 14000, 13025],
      profit_loss: [50, 5125, 3100, 4000, 3025],
      profit_loss_pct: [0.005, 0.5125, 0.31, 0.4, 0.3025],
      base_value: 10000, base_value_asof: '1970-01-01',
      cashflow: {
        CSD: [0, 5000, 0, 0, 0], CSW: [0, 0, -2000, 0, 0],
        JNLC: [0, 0, 0, 1000, 0], ACATC: [0, 0, 0, 0, -1000],
        DIV: [0, 25, 0, 0, 0], INT: [0, 0, 0, 0, 25], FEE: [0, 0, -25, 0, 0],
      },
    }));
    const history = await api.getPortfolioHistory(period);
    expect(history.equity).toEqual([10050, 15125, 13100, 14000, 13025]);
    expect(history.profitLoss).toEqual([50, 125, 100, 0, 25]);
    expect(history.profitLossPct).toEqual([0.005, 0.0125, 0.01, 0, 0.0025]);
    const url = new URL(String(fetchMock.mock.calls[1][0]));
    expect(url.searchParams.get('cashflow_types')).toBe('CSD,CSW,JNLC,ACATC');
  });

  it.each([['1D', '1Min', '1D'], ['1W', '5Min', '1W'], ['1M', '15Min', '30D']] as const)(
    'loads %s history at %s resolution with one extended-session request', async (period, timeframe, requestedPeriod) => {
      // August has 31 days; a calendar-month intraday request can exceed the API limit.
      vi.setSystemTime(new Date('2026-09-21T17:30:00Z'));
      fetchMock.mockResolvedValueOnce(response({ timestamp: [1000, 2000], equity: [10000, 15100],
        profit_loss: [0, 5100], base_value: 10000, base_value_asof: '1970-01-01', cashflow: { CSD: [0, 5000] } }));
      const history = await new AlpacaApi(credentials).getPortfolioHistory(period);
      expect(history.profitLoss).toEqual([0, 100]); expect(fetchMock).toHaveBeenCalledOnce();
      const query = new URL(String(fetchMock.mock.calls[0][0])).searchParams;
      expect(query.get('timeframe')).toBe(timeframe); expect(query.get('period')).toBe(requestedPeriod);
      expect(query.get('intraday_reporting')).toBe('extended_hours'); expect(query.get('pnl_reset')).toBe('no_reset');
      expect(query.get('cashflow_types')).toBe('CSD,CSW,JNLC,ACATC');
      expect(query.has('start')).toBe(false); expect(query.has('end')).toBe(false);
    });

  it.each([[0, '1Min'], [1, '1Min'], [1.01, '5Min'], [7, '5Min'], [7.01, '15Min'], [30, '15Min'], [30.01, '1D'], [365, '1D']] as const)(
    'uses %s-day account age for all-time resolution while preserving the full lifetime', async (days, timeframe) => {
      const createdAt = new Date(Date.now() - days * 86_400_000).toISOString();
      fetchMock.mockResolvedValueOnce(response({ ...account, created_at: createdAt }))
        .mockResolvedValueOnce(response({ timestamp: [1000, 2000], equity: [10000, 10050], profit_loss: [0, 50], base_value: 10000 }));
      const api = new AlpacaApi(credentials); await api.getAccount();
      expect((await api.getPortfolioHistory('ALL')).profitLoss).toEqual([0, 50]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const query = new URL(String(fetchMock.mock.calls[1][0])).searchParams;
      expect(query.get('timeframe')).toBe(timeframe); expect(query.get('start')).toBe(createdAt);
      expect(query.get('end')).toBe(new Date().toISOString()); expect(query.has('period')).toBe(false);
    });

  it('keeps transfers in missing equity windows in subsequent P&L', async () => {
    fetchMock.mockResolvedValueOnce(response({
      timestamp: [1000, 2000, 3000], equity: [10000, null, 15100],
      profit_loss: [0, null, 5100], base_value: 10000, base_value_asof: '1970-01-01',
      cashflow: { CSD: [0, 5000, 0] },
    }));
    const history = await new AlpacaApi(credentials).getPortfolioHistory('1D');
    expect(history.timestamp).toEqual([1000, 3000]);
    expect(history.profitLoss).toEqual([0, 100]);
    expect(history.profitLossPct).toEqual([0, 0.01]);
  });

  it('does not subtract initial funding already in the baseline or show losses before funding', async () => {
    fetchMock.mockResolvedValueOnce(response({
      timestamp: [1000, 2000, 3000, 4000, 5000], equity: [0, 0, 10000, 15100, 13150],
      profit_loss: [0, 0, 0, 5100, 3150], base_value: 10000,
      cashflow: { CSD: [0, 0, 10000, 5000, 0], CSW: [0, 0, 0, 0, -2000] },
    }));
    const history = await new AlpacaApi(credentials).getPortfolioHistory('1M');
    expect(history.profitLoss).toEqual([0, 0, 0, 100, 150]);
    expect(history.profitLossPct).toEqual([0, 0, 0, 0.01, 0.015]);
  });

  it('excludes a transfer in the first window when the baseline is the prior closing balance', async () => {
    fetchMock.mockResolvedValueOnce(response({
      timestamp: [1000, 2000], equity: [15100, 15050], profit_loss: [5100, 5050],
      base_value: 10000, base_value_asof: '1970-01-01', cashflow: { CSD: [5000, 0] },
    }));
    expect((await new AlpacaApi(credentials).getPortfolioHistory('1D')).profitLoss).toEqual([100, 50]);
  });

  it('keeps percentage unavailable for a zero baseline while excluding transfers', async () => {
    fetchMock.mockResolvedValueOnce(response({
      timestamp: [1000, 2000], equity: [5000, 5010], profit_loss: [5000, 5010],
      base_value: 0, base_value_asof: '1970-01-01', cashflow: { CSD: [5000, 0] },
    }));
    const history = await new AlpacaApi(credentials).getPortfolioHistory('1D');
    expect(history.profitLoss).toEqual([0, 10]);
    expect(history.profitLossPct).toEqual([null, null]);
  });

  it.each([{ CSD: [5000] }, { CSD: [0, null] }, { CSW: [0, 'invalid'] }, { JNLC: null }, []])('rejects incomplete transfer data %j', async cashflow => {
    fetchMock.mockResolvedValueOnce(response({
      timestamp: [1000, 2000], equity: [10000, 15100], profit_loss: [0, 5100], base_value: 10000, cashflow,
    }));
    await expect(new AlpacaApi(credentials).getPortfolioHistory('1W')).rejects.toThrow('incomplete cash transfer history');
  });

  it('does not report cash-adjusted P&L when transfers exist but the baseline is unavailable', async () => {
    fetchMock.mockResolvedValueOnce(response({
      timestamp: [1000, 2000], equity: [10000, 15100], profit_loss: [0, 5100], cashflow: { CSD: [0, 5000] },
    }));
    await expect(new AlpacaApi(credentials).getPortfolioHistory('1W')).rejects.toThrow('baseline is unavailable');
  });

  it('requests all-time daily P&L from the broker account creation timestamp without a guessed period', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-17T16:00:00Z'));
    fetchMock.mockResolvedValueOnce(response(account)).mockResolvedValueOnce(response({ timestamp: [1558712046, 1789660800], equity: [10000, 12000], profit_loss: [0, 2000], profit_loss_pct: [0, 0.2], base_value: 10000 }));
    const api = new AlpacaApi(credentials);
    expect((await api.getAccount()).createdAt).toBe(account.created_at);
    const history = await api.getPortfolioHistory('ALL');
    expect(history.profitLoss).toEqual([0, 2000]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const url = new URL(String(fetchMock.mock.calls[1][0]));
    expect(url.searchParams.get('start')).toBe(account.created_at);
    expect(url.searchParams.get('end')).toBe('2026-09-17T16:00:00.000Z');
    expect(url.searchParams.get('timeframe')).toBe('1D');
    expect(url.searchParams.has('period')).toBe(false);
    expect(url.searchParams.has('date_start')).toBe(false);
  });

  it('loads account creation metadata on demand and reports unavailable full-history boundaries honestly', async () => {
    fetchMock.mockResolvedValueOnce(response(account)).mockResolvedValueOnce(response({ timestamp: [], equity: [], profit_loss: [] }));
    const api = new AlpacaApi(credentials);
    expect((await api.getPortfolioHistory('ALL')).timestamp).toEqual([]);
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://paper-api.alpaca.markets/v2/account');
    fetchMock.mockResolvedValueOnce(response({ ...account, created_at: undefined }));
    const missingDate = new AlpacaApi(credentials);
    expect((await missingDate.getAccount()).createdAt).toBeNull();
    await expect(missingDate.getPortfolioHistory('ALL')).rejects.toThrow('creation date is unavailable');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('reports a malformed portfolio series as an import error instead of an empty history', async () => {
    fetchMock.mockResolvedValueOnce(response({ timestamp: [], equity: [] }));
    await expect(new AlpacaApi(credentials).getPortfolioHistory('1D')).rejects.toThrow('incomplete portfolio history');
  });

  it('keeps unavailable history percentages and baseline null and skips invalid timestamp slots', async () => {
    fetchMock.mockResolvedValueOnce(response({ timestamp: [1000, null, 3000, 4000], equity: [10000, 10050, 10100, null], profit_loss: [0, 50, 100, 0], profit_loss_pct: [0, 0.005, null, 0] }));
    expect(await new AlpacaApi(credentials).getPortfolioHistory('1D')).toEqual({
      timestamp: [1000, 3000], equity: [10000, 10100], profitLoss: [0, 100], profitLossPct: [0, null], baseValue: null,
    });
  });

  it('rejects missing account trading status instead of assuming execution is allowed', async () => {
    fetchMock.mockResolvedValueOnce(response({ ...account, trading_blocked: undefined }));
    await expect(new AlpacaApi(credentials).getAccount()).rejects.toThrow('incomplete account data');
  });

  it('disposal aborts pending reads and prevents the credentials from being used again', async () => {
    fetchMock.mockImplementationOnce((_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    }));
    const api = new AlpacaApi(credentials);
    const pending = api.getAccount();
    api.dispose();
    await expect(pending).rejects.toThrow('closed');
    await expect(api.getAccount()).rejects.toThrow('closed');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

});
