import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiActivity } from '../core/api-activity';
import { BrokerTransport } from './http';
import { AlpacaApi } from './alpaca';
import { ScannerDataApi } from './market-data';

const credentials = { keyId: 'test-key', secretKey: 'test-secret', environment: 'paper' as const };
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
describe('HTTP attempt instrumentation', () => {
  it('counts every actual retry, but not an already cancelled or disposed read', async () => {
    vi.useFakeTimers(); const activity = new ApiActivity();
    const fetcher = vi.fn().mockResolvedValueOnce(new Response('{}', { status: 503 })).mockResolvedValue(new Response('{}'));
    const transport = new BrokerTransport(credentials, fetcher, activity);
    const request = transport.request('https://paper-api.alpaca.markets/v2/account');
    await vi.advanceTimersByTimeAsync(1000); await request;
    expect(activity.snapshot()).toMatchObject({ trading: 2, groups: [{ count: 2, retries: 1, failed: 1 }] });
    const controller = new AbortController(); controller.abort();
    await expect(transport.request('https://data.alpaca.markets/v2/stocks/bars', { signal: controller.signal })).rejects.toThrow();
    transport.dispose(); await expect(transport.request('https://paper-api.alpaca.markets/v2/account')).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(activity.snapshot().trading).toBe(2);
  });
  it('aggregates trading, bulk scanner, and critical robot clients by the actual host', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(url.includes('/v2/stocks/') ? '{"bars":{},"next_page_token":null}' : '[]')));
    const activity = new ApiActivity(), api = new AlpacaApi(credentials, activity);
    const bulk = new ScannerDataApi(credentials, { activity, minRequestIntervalMs: 0 });
    const critical = new ScannerDataApi(credentials, { activity, minRequestIntervalMs: 0 });
    await api.getOrders(); await bulk.getEligibleAssets();
    await critical.getBars(['SPY'], { timeframe: '5Min', start: 300_000, end: 600_000 });
    expect(activity.snapshot()).toMatchObject({ trading: 3, marketData: 1 });
    api.dispose(); bulk.dispose(); critical.dispose();
  });
  it('records a failed write once without retaining its body or credentials', async () => {
    const activity = new ApiActivity(), transport = new BrokerTransport(credentials, vi.fn(async () => { throw new Error('network'); }), activity);
    await expect(transport.request('https://api.alpaca.markets/v2/orders', { method: 'POST', body: { client_order_id: 'private-intent' } })).rejects.toThrow();
    expect(activity.snapshot()).toMatchObject({ trading: 1, groups: [{ method: 'POST', failed: 1, statuses: { 'Network error': 1 } }] });
    expect(JSON.stringify(activity.snapshot())).not.toMatch(/private-intent|test-key|test-secret/);
    transport.dispose();
  });
});
