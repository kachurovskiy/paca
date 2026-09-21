import { describe, expect, it } from 'vitest';
import { ApiActivity } from './api-activity';

describe('rolling Alpaca HTTP activity', () => {
  it('counts attempts by API and endpoint, including pending calls, retries, and failures', () => {
    let now = 100_000; const activity = new ApiActivity(() => now);
    const done = activity.start('https://paper-api.alpaca.markets/v2/account', 'GET', false);
    now += 100; done(429, true, false);
    activity.start('https://api.alpaca.markets/v2/account', 'GET', true)(200, false, false);
    activity.start('https://data.alpaca.markets/v2/stocks/bars?symbols=SPY&feed=boats&timeframe=5Min&page_token=1', 'GET', false);
    activity.start('https://data.alpaca.markets/v2/stocks/bars?symbols=QQQ&feed=boats&timeframe=5Min&page_token=2', 'GET', false)(undefined, true, false);
    const snapshot = activity.snapshot();
    expect(snapshot).toMatchObject({ trading: 2, marketData: 2 });
    expect(snapshot.groups.find(group => group.api === 'trading')).toMatchObject({ count: 2, retries: 1, failed: 1, completed: 2, totalDurationMs: 100, statuses: { '200': 1, '429': 1 } });
    expect(snapshot.groups.find(group => group.api === 'market-data')).toMatchObject({ count: 2, pending: 1, failed: 1, endpoint: '/v2/stocks/bars?feed=boats&timeframe=5Min' });
  });
  it('expires idle and pending calls by request start and retains no credentials or identifiers', () => {
    let now = 1000; const activity = new ApiActivity(() => now);
    const finish = activity.start('https://api.alpaca.markets/v2/orders/private-order?client_order_id=private-client&secret_key=private-secret&nested=true', 'DELETE', false);
    activity.start('https://data.alpaca.markets/v2/stocks/SPY/bars?timeframe=5Min', 'GET', false)(undefined, true, true);
    activity.start('https://other.example/v2/account', 'GET', false);
    expect(JSON.stringify(activity.snapshot())).not.toMatch(/private-|SPY|other.example/);
    now = 60_999; expect(activity.snapshot().trading).toBe(1);
    now = 61_000; expect(activity.snapshot()).toMatchObject({ trading: 0, marketData: 0, groups: [] });
    finish(200, false, false); expect(activity.snapshot().groups).toEqual([]);
    expect(new ApiActivity(() => now).snapshot().trading).toBe(0);
  });
});
