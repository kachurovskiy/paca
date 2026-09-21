import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AlpacaStream } from './stream';
import { type StockFeed, type StreamHandlers } from '../core/stream';
import type { Credentials } from '../core/types';

class MockSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: MockSocket[] = [];
  readyState = MockSocket.CONNECTING;
  sent: Record<string, unknown>[] = [];
  constructor(readonly url: string) { super(); MockSocket.instances.push(this); }
  open(): void { this.readyState = MockSocket.OPEN; this.dispatchEvent(new Event('open')); }
  send(message: string): void { this.sent.push(JSON.parse(message)); }
  close(): void { this.readyState = MockSocket.CLOSED; this.dispatchEvent(new Event('close')); }
  receive(frames: unknown): void { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(frames) })); }
  raw(data: unknown): void { this.dispatchEvent(new MessageEvent('message', { data })); }
}

const credentials: Credentials = { keyId: 'stream-key-example', secretKey: 'stream-secret-example', environment: 'paper' };
const timestamp = '2026-09-17T14:31:30.123456789Z';
const acknowledgment = (symbols: string[]) => [{ T: 'subscription', trades: symbols, quotes: symbols, bars: symbols }];
const sockets = () => MockSocket.instances;
const latestSocket = () => sockets().at(-1)!;
const createHandlers = () => ({
  onStatus: vi.fn<StreamHandlers['onStatus']>(), onTrade: vi.fn<StreamHandlers['onTrade']>(),
  onQuote: vi.fn<StreamHandlers['onQuote']>(), onBar: vi.fn<NonNullable<StreamHandlers['onBar']>>(),
});

describe('AlpacaStream', () => {
  let streams: AlpacaStream[];
  let handlers: ReturnType<typeof createHandlers>;
  beforeEach(() => {
    vi.useFakeTimers();
    MockSocket.instances = [];
    vi.stubGlobal('WebSocket', MockSocket);
    streams = [];
    handlers = createHandlers();
  });
  afterEach(() => { streams.forEach(stream => stream.dispose()); vi.useRealTimers(); vi.unstubAllGlobals(); });
  const make = (feed: StockFeed = 'sip') => {
    const stream = new AlpacaStream(credentials, handlers, feed);
    streams.push(stream);
    return stream;
  };
  const authenticate = (socket: MockSocket = latestSocket()) => {
    socket.open();
    socket.receive([{ T: 'success', msg: 'connected' }]);
    socket.receive([{ T: 'success', msg: 'authenticated' }]);
  };
  const ready = async (stream: AlpacaStream, symbols = ['SPY']) => {
    const pending = stream.connect(symbols);
    authenticate();
    latestSocket().receive(acknowledgment(symbols));
    await pending;
  };

  it('authenticates only after connected and resolves only after every requested channel is acknowledged', async () => {
    const stream = make();
    let settled = false;
    const pending = stream.connect([' spy ', 'QQQ', 'SPY']).then(() => { settled = true; });
    const socket = latestSocket();
    expect(socket.url).toBe('wss://stream.data.alpaca.markets/v2/sip');
    expect(socket.sent).toEqual([]);
    socket.open();
    expect(socket.sent).toEqual([]);
    socket.receive([{ T: 'success', msg: 'connected' }]);
    expect(socket.sent).toEqual([{ action: 'auth', key: credentials.keyId, secret: credentials.secretKey }]);
    socket.receive([{ T: 'success', msg: 'authenticated' }]);
    expect(socket.sent[1]).toEqual({ action: 'subscribe', trades: ['SPY', 'QQQ'], quotes: ['SPY', 'QQQ'], bars: ['SPY', 'QQQ'] });
    socket.receive([{ T: 'subscription', trades: ['SPY', 'QQQ'], quotes: ['SPY', 'QQQ'], bars: ['SPY'] }]);
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(handlers.onStatus).not.toHaveBeenCalledWith('ready', expect.anything());
    expect(socket.sent.at(-1)).toEqual({ action: 'subscribe', bars: ['QQQ'] });
    socket.receive(acknowledgment(['SPY', 'QQQ']));
    await pending;
    expect(settled).toBe(true);
    expect(handlers.onStatus).toHaveBeenLastCalledWith('ready', expect.any(String));
  });

  it('rejects invalid symbols and unsupported delayed feeds without opening a socket', async () => {
    await expect(make().connect(['*'])).rejects.toThrow('valid US stock');
    for (const feed of ['delayed_sip', 'overnight']) {
      expect(() => new AlpacaStream(credentials, handlers, feed as StockFeed)).toThrow('supported stock-data feed');
    }
    expect(sockets()).toHaveLength(0);
  });

  it('uses the overnight API version for BOATS', async () => {
    const stream = make('boats');
    await ready(stream);
    expect(latestSocket().url).toBe('wss://stream.data.alpaca.markets/v1beta1/boats');
    expect(latestSocket().sent.at(-1)).toEqual({ action: 'subscribe', trades: ['SPY'], quotes: ['SPY'], bars: ['SPY'] });
    expect(handlers.onStatus).toHaveBeenLastCalledWith('ready', expect.stringContaining('real-time trades, quotes, and bars'));
  });

  it('switches sessions with fresh authentication and acknowledgments, preserving consumers and ignoring old-socket events', async () => {
    const stream = make('sip');
    await ready(stream);
    const listener = { onQuote: vi.fn(), onBar: vi.fn() };
    stream.addListener(listener);
    stream.setOwnerSubscriptions('scanner', { quotes: ['AAPL'], bars: ['AAPL'], updatedBars: ['AAPL'], statuses: ['AAPL'] });
    latestSocket().receive([{ T: 'subscription', trades: ['SPY'], quotes: ['SPY', 'AAPL'], bars: ['SPY', 'AAPL'], updatedBars: ['AAPL'], statuses: ['AAPL'] }]);
    const old = latestSocket();
    stream.setFeed('boats');
    expect(old.readyState).toBe(MockSocket.CLOSED);
    expect(latestSocket().url).toBe('wss://stream.data.alpaca.markets/v1beta1/boats');
    expect(handlers.onStatus).toHaveBeenLastCalledWith('connecting', expect.any(String));
    expect(stream.statusCapability('scanner')).toBe('unsupported');
    old.receive([{ T: 'q', S: 'AAPL', bp: 100, ap: 101, t: timestamp }]);
    authenticate();
    expect(latestSocket().sent.at(-1)).toEqual({ action: 'subscribe', trades: ['SPY'], quotes: ['SPY', 'AAPL'], bars: ['SPY', 'AAPL'] });
    latestSocket().receive([{ T: 'q', S: 'SPY', bp: 600, ap: 601, t: timestamp }]);
    expect(handlers.onQuote).not.toHaveBeenCalled();
    expect(listener.onQuote).not.toHaveBeenCalled();
    latestSocket().receive([{ T: 'subscription', trades: ['SPY'], quotes: ['SPY', 'AAPL'], bars: ['SPY', 'AAPL'] }]);
    latestSocket().receive([{ T: 'q', S: 'SPY', bp: 600, ap: 601, t: timestamp }]);
    expect(handlers.onQuote).toHaveBeenCalledOnce();
    expect(listener.onQuote).toHaveBeenCalledOnce();
    stream.setFeed('sip');
    authenticate();
    expect(latestSocket().sent.at(-1)).toEqual({ action: 'subscribe', trades: ['SPY'], quotes: ['SPY', 'AAPL'], bars: ['SPY', 'AAPL'], updatedBars: ['AAPL'], statuses: ['AAPL'] });
    expect(stream.statusCapability('scanner')).toBe('pending');
  });

  it('cancels old reconnect timers and preserves a pending connection through a feed transition', async () => {
    const stream = make();
    const pending = stream.connect(['SPY']);
    authenticate();
    stream.setFeed('boats');
    authenticate();
    latestSocket().receive(acknowledgment(['SPY']));
    await pending;
    latestSocket().close();
    stream.setFeed('sip');
    const daytime = latestSocket();
    authenticate();
    daytime.receive(acknowledgment(['SPY']));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(latestSocket()).toBe(daytime);
    expect(sockets()).toHaveLength(3);
    expect(handlers.onStatus).toHaveBeenLastCalledWith('ready', expect.any(String));
  });

  it('validates feed changes and defers connecting until symbols are selected', async () => {
    const stream = make();
    expect(() => stream.setFeed('delayed_sip' as StockFeed)).toThrow('supported stock-data feed');
    stream.setFeed('boats');
    expect(sockets()).toHaveLength(0);
    await ready(stream);
    const socket = latestSocket();
    stream.setFeed('boats');
    expect(latestSocket()).toBe(socket);
    stream.dispose();
    expect(() => stream.setFeed('sip')).toThrow('closed');
  });

  it('reports SIP entitlement failure, redacts keys, and never changes feed or retries it', async () => {
    const pending = make('sip').connect(['SPY']);
    const rejection = expect(pending).rejects.toThrow('subscription does not include');
    latestSocket().open();
    latestSocket().receive([{ T: 'success', msg: 'connected' }]);
    latestSocket().receive([{ T: 'error', code: 409, msg: `${credentials.keyId} ${credentials.secretKey} no entitlement` }]);
    await rejection;
    expect(latestSocket().url).toBe('wss://stream.data.alpaca.markets/v2/sip');
    const statusText = JSON.stringify(handlers.onStatus.mock.calls);
    expect(statusText).toContain('required SIP real-time feed');
    expect(statusText).not.toContain(credentials.keyId);
    expect(statusText).not.toContain(credentials.secretKey);
    expect(statusText).toContain('[redacted]');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(sockets()).toHaveLength(1);
  });

  it('explains the 406 connection limit instead of claiming authentication succeeded', async () => {
    const pending = make().connect(['SPY']);
    const rejection = expect(pending).rejects.toThrow('connection limit');
    latestSocket().open();
    latestSocket().receive([{ T: 'error', code: 406, msg: 'connection limit exceeded' }]);
    await rejection;
    expect(handlers.onStatus).toHaveBeenLastCalledWith('error', expect.stringContaining('another app or browser tab'));
  });

  it('ignores pre-subscription and foreign-symbol events and forwards validated real prices, quotes, and candles', async () => {
    const stream = make();
    const pending = stream.connect(['SPY']);
    authenticate();
    latestSocket().receive([{ T: 't', S: 'SPY', p: 600, t: timestamp }]);
    expect(handlers.onTrade).not.toHaveBeenCalled();
    latestSocket().receive(acknowledgment(['SPY']));
    await pending;
    latestSocket().receive([
      { T: 't', S: 'QQQ', p: 450, t: timestamp },
      { T: 't', S: 'SPY', p: 605.15, t: timestamp },
      { T: 'q', S: 'SPY', bp: 0, ap: 605.16, t: timestamp },
      { T: 'b', S: 'SPY', o: 605, h: 606, l: 604, c: 605.15, v: 1200, t: '2026-09-17T14:31:00Z' },
      { T: 'c', S: 'SPY', cp: 604, t: timestamp },
      { T: 'x', S: 'SPY', p: 603, t: timestamp },
    ]);
    expect(handlers.onTrade).toHaveBeenCalledExactlyOnceWith({ symbol: 'SPY', price: 605.15, timestamp });
    expect(handlers.onQuote).toHaveBeenCalledExactlyOnceWith({ symbol: 'SPY', bid: null, ask: 605.16, bidSize: null, askSize: null, timestamp });
    expect(handlers.onBar).toHaveBeenCalledExactlyOnceWith({ symbol: 'SPY', t: '2026-09-17T14:31:00Z', o: 605, h: 606, l: 604, c: 605.15, v: 1200, vw: null, revision: false });
  });

  it('adds and removes subscriptions by difference, gating events until the new set is acknowledged', async () => {
    const stream = make();
    await ready(stream, ['SPY', 'QQQ']);
    const socket = latestSocket();
    stream.setSymbols(['SPY', 'AAPL']);
    expect(socket.sent.at(-1)).toEqual({ action: 'unsubscribe', trades: ['QQQ'], quotes: ['QQQ'], bars: ['QQQ'] });
    socket.receive([{ T: 't', S: 'SPY', p: 600, t: timestamp }]);
    expect(handlers.onTrade).not.toHaveBeenCalled();
    socket.receive(acknowledgment(['SPY']));
    expect(socket.sent.at(-1)).toEqual({ action: 'subscribe', trades: ['AAPL'], quotes: ['AAPL'], bars: ['AAPL'] });
    socket.receive(acknowledgment(['SPY', 'AAPL']));
    expect(handlers.onStatus).toHaveBeenLastCalledWith('ready', expect.any(String));
    const count = socket.sent.length;
    stream.setSymbols(['AAPL', 'SPY']);
    expect(socket.sent).toHaveLength(count);
  });

  it('reconciles changes made while the first subscription acknowledgment is outstanding', async () => {
    const stream = make();
    const pending = stream.connect(['SPY']);
    authenticate();
    stream.setSymbols(['AAPL']);
    latestSocket().receive(acknowledgment(['SPY']));
    expect(latestSocket().sent.at(-1)).toEqual({ action: 'unsubscribe', trades: ['SPY'], quotes: ['SPY'], bars: ['SPY'] });
    latestSocket().receive(acknowledgment([]));
    expect(latestSocket().sent.at(-1)).toEqual({ action: 'subscribe', trades: ['AAPL'], quotes: ['AAPL'], bars: ['AAPL'] });
    latestSocket().receive(acknowledgment(['AAPL']));
    await pending;
  });

  it('times out a silent connection and never reports it ready', async () => {
    const pending = make().connect(['SPY']);
    const rejection = expect(pending).rejects.toThrow('connection timed out');
    await vi.advanceTimersByTimeAsync(15_000);
    await rejection;
    expect(handlers.onStatus).not.toHaveBeenCalledWith('ready', expect.anything());
  });

  it('does not let repeated partial acknowledgments extend the subscription deadline indefinitely', async () => {
    const pending = make().connect(['SPY']);
    const rejection = expect(pending).rejects.toThrow('subscription timed out');
    authenticate();
    for (let repeat = 0; repeat < 2; repeat++) {
      await vi.advanceTimersByTimeAsync(5000);
      latestSocket().receive([{ T: 'subscription', trades: ['SPY'], quotes: [], bars: [] }]);
    }
    await vi.advanceTimersByTimeAsync(5000);
    await rejection;
  });

  it('reconnects an unexpected close, ignores late old-socket frames, and requires authentication and acknowledgments again', async () => {
    const stream = make();
    await ready(stream);
    const old = latestSocket();
    old.close();
    expect(handlers.onStatus).toHaveBeenLastCalledWith('disconnected', expect.stringContaining('1 seconds'));
    old.receive([{ T: 't', S: 'SPY', p: 999, t: timestamp }]);
    expect(handlers.onTrade).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(999);
    expect(sockets()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets()).toHaveLength(2);
    authenticate();
    expect(latestSocket().sent[0]).toMatchObject({ action: 'auth', key: credentials.keyId, secret: credentials.secretKey });
    expect(handlers.onStatus).toHaveBeenLastCalledWith('subscribing', expect.any(String));
    latestSocket().receive(acknowledgment(['SPY']));
    expect(handlers.onStatus).toHaveBeenLastCalledWith('ready', expect.any(String));
  });

  it('bounds consecutive failed reconnect attempts using exponential backoff', async () => {
    const stream = make();
    await ready(stream);
    for (const delay of [1000, 2000, 4000, 8000, 16000]) {
      latestSocket().close();
      await vi.advanceTimersByTimeAsync(delay);
    }
    latestSocket().close();
    expect(handlers.onStatus).toHaveBeenLastCalledWith('error', expect.stringContaining('attempts exhausted'));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(sockets()).toHaveLength(6);
  });

  it('disposal cancels reconnects, clears credentials, and prevents reuse', async () => {
    const stream = make();
    await ready(stream);
    latestSocket().close();
    stream.dispose();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(sockets()).toHaveLength(1);
    expect(Reflect.get(stream, 'keyId')).toBe('');
    expect(Reflect.get(stream, 'secretKey')).toBe('');
    await expect(stream.connect(['SPY'])).rejects.toThrow('closed');
    expect(() => stream.setSymbols(['AAPL'])).toThrow('closed');
  });

  it.each([
    ['malformed JSON', '{not-json'],
    ['non-array payload', JSON.stringify({ T: 'success', msg: 'connected' })],
    ['invalid control message', JSON.stringify([{ T: 'success', msg: 'authenticated' }])],
  ])('fails closed on %s', async (_label, message) => {
    const pending = make().connect(['SPY']);
    const rejection = expect(pending).rejects.toThrow();
    latestSocket().open(); latestSocket().raw(message);
    await rejection;
    expect(handlers.onStatus).toHaveBeenLastCalledWith('error', expect.any(String));
  });

  it.each([
    { T: 't', S: 'SPY', p: '605', t: timestamp },
    { T: 't', S: 'SPY', p: 605, t: 'not-a-timestamp' },
    { T: 'q', S: 'SPY', bp: -1, ap: 605, t: timestamp },
    { T: 'b', S: 'SPY', c: 605, t: timestamp },
  ])('fails closed without fabricating values for invalid real-time data: $T', async frame => {
    const stream = make();
    await ready(stream);
    latestSocket().receive([frame]);
    expect(handlers.onTrade).not.toHaveBeenCalled();
    expect(handlers.onQuote).not.toHaveBeenCalled();
    expect(handlers.onBar).not.toHaveBeenCalled();
    expect(handlers.onStatus).toHaveBeenLastCalledWith('error', expect.any(String));
  });

  it('shares per-channel owner subscriptions without adding scanner trades or removing main symbols', async () => {
    const stream = make('sip');
    await ready(stream);
    const socket = latestSocket();
    stream.setOwnerSubscriptions('scanner', { bars: ['SPY', 'AAPL'], updatedBars: ['SPY', 'AAPL'], quotes: ['AAPL'] });
    expect(socket.sent.at(-1)).toEqual({ action: 'subscribe', quotes: ['AAPL'], bars: ['AAPL'], updatedBars: ['SPY', 'AAPL'] });
    socket.receive([{ T: 'subscription', trades: ['SPY'], quotes: ['SPY', 'AAPL'], bars: ['SPY', 'AAPL'], updatedBars: ['SPY', 'AAPL'] }]);
    stream.setSymbols(['AAPL']);
    expect(socket.sent.at(-1)).toEqual({ action: 'unsubscribe', trades: ['SPY'], quotes: ['SPY'] });
    socket.receive([{ T: 'subscription', trades: [], quotes: ['AAPL'], bars: ['SPY', 'AAPL'], updatedBars: ['SPY', 'AAPL'] }]);
    expect(socket.sent.at(-1)).toEqual({ action: 'subscribe', trades: ['AAPL'] });
    socket.receive([{ T: 'subscription', trades: ['AAPL'], quotes: ['AAPL'], bars: ['SPY', 'AAPL'], updatedBars: ['SPY', 'AAPL'] }]);
    stream.removeOwner('scanner');
    expect(socket.sent.at(-1)).toEqual({ action: 'unsubscribe', bars: ['SPY'], updatedBars: ['SPY', 'AAPL'] });
    socket.receive([{ T: 'subscription', trades: ['AAPL'], quotes: ['AAPL'], bars: ['AAPL'], updatedBars: [] }]);
    expect(handlers.onStatus).toHaveBeenLastCalledWith('ready', expect.any(String));
  });

  it('exposes quote sizes and explicit bar revisions to independent listeners without driving scanner-only chart updates', async () => {
    const stream = make('sip');
    await ready(stream);
    const scanner = { onBar: vi.fn(), onQuote: vi.fn() };
    const remove = stream.addListener(scanner);
    stream.setOwnerSubscriptions('scanner', { bars: ['AAPL'], updatedBars: ['AAPL'], quotes: ['AAPL'] });
    latestSocket().receive([{ T: 'subscription', trades: ['SPY'], quotes: ['SPY', 'AAPL'], bars: ['SPY', 'AAPL'], updatedBars: ['AAPL'] }]);
    const base = { S: 'AAPL', t: '2026-09-17T14:31:00Z', o: 100, h: 101, l: 99, c: 100.5, v: 1000, vw: 100.25 };
    latestSocket().receive([{ T: 'b', ...base }, { T: 'u', ...base, v: 1100 }, { T: 'q', S: 'AAPL', bp: 100, ap: 100.01, bs: 3, as: 5, t: timestamp }]);
    expect(scanner.onBar.mock.calls.map(([bar]) => [bar.v, bar.vw, bar.revision])).toEqual([[1000, 100.25, false], [1100, 100.25, true]]);
    expect(scanner.onQuote).toHaveBeenCalledWith({ symbol: 'AAPL', bid: 100, ask: 100.01, bidSize: 3, askSize: 5, timestamp });
    expect(handlers.onBar).not.toHaveBeenCalled();
    expect(handlers.onQuote).not.toHaveBeenCalled();
    remove();
    latestSocket().receive([{ T: 'u', ...base, v: 1200 }]);
    expect(scanner.onBar).toHaveBeenCalledTimes(2);
  });

  it.each([405, 410])('rolls back scanner subscription rejection %s without dropping the acknowledged main feed', async code => {
    const stream = make('sip');
    await ready(stream);
    const listener = { onSubscriptionError: vi.fn() };
    stream.addListener(listener);
    stream.setOwnerSubscriptions('scanner', { bars: ['AAPL'], updatedBars: ['AAPL'] });
    latestSocket().receive([{ T: 'error', code, msg: 'not supported' }]);
    expect(listener.onSubscriptionError).toHaveBeenCalledWith('scanner', expect.any(String));
    expect(stream.ownerSubscriptionError('scanner')).toContain('not supported');
    expect(handlers.onStatus).toHaveBeenLastCalledWith('ready', expect.any(String));
    latestSocket().receive([{ T: 't', S: 'SPY', p: 605.15, t: timestamp }]);
    expect(handlers.onTrade).toHaveBeenCalledOnce();
    expect(sockets()).toHaveLength(1);
  });

  it('switches feed explicitly after an entitlement failure within its owning session', async () => {
    let held = false;
    const request = vi.fn(async (_name: string, _options: unknown, callback: (lock: object | null) => Promise<void>) => {
      if (held) return callback(null);
      held = true;
      try { await callback({}); } finally { held = false; }
    });
    vi.stubGlobal('navigator', { locks: { request } });
    const stream = make('boats');
    await ready(stream);
    latestSocket().receive([{ T: 'error', code: 409, msg: 'No overnight entitlement' }]);
    expect(handlers.onStatus).toHaveBeenLastCalledWith('error', expect.stringContaining('subscription does not include'));
    stream.setFeed('sip');
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets()).toHaveLength(2);
    expect(request).not.toHaveBeenCalled();
    authenticate();
    latestSocket().receive(acknowledgment(['SPY']));
    expect(handlers.onStatus).toHaveBeenLastCalledWith('ready', expect.any(String));
  });

  it('keeps acknowledged scanner bars flowing during shortlist changes while main callbacks stay readiness-gated', async () => {
    const stream = make('sip');
    await ready(stream);
    const listener = { onBar: vi.fn() };
    stream.addListener(listener);
    stream.setOwnerSubscriptions('scanner', { bars: ['AAPL'], updatedBars: ['AAPL'] });
    latestSocket().receive([{ T: 'subscription', trades: ['SPY'], quotes: ['SPY'], bars: ['SPY', 'AAPL'], updatedBars: ['AAPL'] }]);
    stream.setOwnerSubscriptions('scanner', { bars: ['AAPL'], updatedBars: ['AAPL'], quotes: ['AAPL'] });
    latestSocket().receive([
      { T: 'b', S: 'AAPL', t: '2026-09-17T14:31:00Z', o: 100, h: 101, l: 99, c: 100.5, v: 1000, vw: 100.25 },
      { T: 't', S: 'SPY', p: 605, t: timestamp },
    ]);
    expect(listener.onBar).toHaveBeenCalledOnce();
    expect(handlers.onTrade).not.toHaveBeenCalled();
  });

  it('recognizes optional trading-status capability only after acknowledgment and forwards explicit status events', async () => {
    const stream = make('sip');
    await ready(stream);
    const listener = { onStatusCapability: vi.fn(), onTradingStatus: vi.fn() };
    stream.addListener(listener);
    stream.setOwnerSubscriptions('scanner', { bars: ['AAPL'], updatedBars: ['AAPL'], statuses: ['AAPL'] });
    expect(stream.statusCapability('scanner')).toBe('pending');
    expect(latestSocket().sent.at(-1)).toEqual({ action: 'subscribe', bars: ['AAPL'], updatedBars: ['AAPL'], statuses: ['AAPL'] });
    latestSocket().receive([{ T: 'subscription', trades: ['SPY'], quotes: ['SPY'], bars: ['SPY', 'AAPL'], updatedBars: ['AAPL'], statuses: ['AAPL'] }]);
    expect(stream.statusCapability('scanner')).toBe('supported');
    latestSocket().receive([{ T: 's', S: 'AAPL', sc: 'H', sm: 'Trading Halt', rc: 'T1', rm: 'Halt News Pending', t: timestamp }]);
    expect(listener.onTradingStatus).toHaveBeenCalledWith({ symbol: 'AAPL', statusCode: 'H', message: 'Trading Halt', timestamp });
    stream.removeOwner('scanner');
    expect(latestSocket().sent.at(-1)).toMatchObject({ action: 'unsubscribe', statuses: ['AAPL'] });
    expect(stream.statusCapability('scanner')).toBe('disabled');
  });

  it('removes only rejected optional statuses, retries core scanner channels, and does not repeatedly probe unsupported access', async () => {
    const stream = make('sip');
    await ready(stream);
    const listener = { onStatusCapability: vi.fn(), onSubscriptionError: vi.fn() };
    stream.addListener(listener);
    const requested = { bars: ['AAPL'], updatedBars: ['AAPL'], quotes: ['AAPL'], statuses: ['AAPL'] };
    stream.setOwnerSubscriptions('scanner', requested);
    latestSocket().receive([{ T: 'error', code: 410, msg: 'invalid subscription action for this feed' }]);
    expect(stream.statusCapability('scanner')).toBe('unsupported');
    expect(listener.onSubscriptionError).not.toHaveBeenCalled();
    expect(latestSocket().sent.at(-1)).toEqual({ action: 'subscribe', quotes: ['AAPL'], bars: ['AAPL'], updatedBars: ['AAPL'] });
    latestSocket().receive([{ T: 'subscription', trades: ['SPY'], quotes: ['SPY', 'AAPL'], bars: ['SPY', 'AAPL'], updatedBars: ['AAPL'] }]);
    expect(handlers.onStatus).toHaveBeenLastCalledWith('ready', expect.any(String));
    const count = latestSocket().sent.length;
    stream.setOwnerSubscriptions('scanner', requested);
    expect(latestSocket().sent).toHaveLength(count);
    expect(sockets()).toHaveLength(1);
  });
});
