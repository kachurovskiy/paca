import type { OwnerSubscriptions, StatusCapability, StockFeed, StreamChannel, StreamHandlers, StreamStatus } from '../core/stream';
import type { Credentials } from '../core/types';
type Channel = StreamChannel;
type Subscription = Record<Channel, Set<string>>;
type Frame = Record<string, unknown>;
const CHANNELS: Channel[] = ['trades', 'quotes', 'bars', 'updatedBars', 'statuses'];
const TIMEOUT = 15_000;
const MAX_RECONNECTS = 5;
const emptySubscription = (): Subscription => ({ trades: new Set(), quotes: new Set(), bars: new Set(), updatedBars: new Set(), statuses: new Set() });
const isPrice = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;
const isTimestamp = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
const validSymbol = (value: unknown): value is string => typeof value === 'string' && /^[A-Z][A-Z0-9.-]{0,14}$/.test(value);
const validFeed = (value: unknown): value is StockFeed => ['sip', 'boats'].includes(String(value));

function symbols(values: string[]): Set<string> {
  const result = new Set(values.map(value => value.trim().toUpperCase()));
  if (!result.size || [...result].some(value => !validSymbol(value))) throw new Error('Choose at least one valid US stock or ETF symbol for the stream.');
  return result;
}

/** Authenticated stock data. Readiness requires a server subscription acknowledgment. */
export class AlpacaStream {
  private keyId: string;
  private secretKey: string;
  private feed: StockFeed;
  private socket: WebSocket | null = null;
  private desired = new Set<string>();
  private owners = new Map<string, Subscription>();
  private ownerErrors = new Map<string, string>();
  private statusCapabilities = new Map<string, StatusCapability>();
  private listeners = new Set<Partial<StreamHandlers>>();
  private subscriptions = emptySubscription();
  private status: StreamStatus = 'disconnected';
  private authenticated = false;
  private waitingForSubscription = false;
  private pendingCommand: Frame | null = null;
  private active = false;
  private disposed = false;
  private retryCount = 0;
  private phaseTimer: ReturnType<typeof setTimeout> | undefined;
  private timeoutPhase = '';
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private waiters: { resolve: () => void; reject: (error: Error) => void }[] = [];

  constructor(credentials: Credentials, private readonly handlers: StreamHandlers, feed: StockFeed = 'sip') {
    if (!credentials.keyId.trim() || !credentials.secretKey.trim() || /[\r\n]/.test(credentials.keyId + credentials.secretKey)) throw new Error('Enter a valid Alpaca key and secret for real-time data.');
    if (!validFeed(feed)) throw new Error('Choose a supported stock-data feed.');
    this.keyId = credentials.keyId.trim();
    this.secretKey = credentials.secretKey.trim();
    this.feed = feed;
  }

  private get overnight(): boolean { return this.feed === 'boats'; }
  private get endpoint(): string { return `wss://stream.data.alpaca.markets/${this.overnight ? 'v1beta1' : 'v2'}/${this.feed}`; }

  /** Session transitions retain consumers but require a fresh authenticated subscription on the new feed. */
  setFeed(feed: StockFeed): void {
    if (this.disposed) throw new Error('This stream is closed.');
    if (!validFeed(feed)) throw new Error('Choose a supported stock-data feed.');
    if (feed === this.feed) return;
    this.feed = feed;
    this.clearTimers();
    this.retryCount = 0;
    this.ownerErrors.clear();
    this.closeSocket();
    if (!this.desired.size) return;
    this.active = true;
    this.openSocket();
  }

  async connect(values: string[]): Promise<void> {
    if (this.disposed) throw new Error('This stream is closed. Create a new connection.');
    this.desired = symbols(values);
    const ready = new Promise<void>((resolve, reject) => this.waiters.push({ resolve, reject }));
    if (!this.active) {
      this.active = true;
      this.retryCount = 0;
      this.openSocket();
    } else if (this.authenticated) this.reconcileSubscriptions();
    return ready;
  }

  /** Applies subscription differences. Events remain gated until the new complete set is acknowledged. */
  setSymbols(values: string[]): void {
    if (this.disposed) throw new Error('This stream is closed.');
    const desired = symbols(values);
    if (desired.size === this.desired.size && [...desired].every(value => this.desired.has(value))) return;
    this.desired = desired;
    if (this.authenticated) {
      this.report('subscribing', 'Updating real-time stock subscriptions…');
      if (!this.waitingForSubscription) this.reconcileSubscriptions();
    }
  }

  /** Each consumer owns only its own channel sets; the socket subscribes to their union. */
  setOwnerSubscriptions(owner: string, values: OwnerSubscriptions): void {
    if (this.disposed) throw new Error('This stream is closed.');
    if (!owner.trim()) throw new Error('A stream subscription owner is required.');
    const next = emptySubscription();
    for (const channel of CHANNELS) next[channel] = values[channel]?.length ? symbols(values[channel]!) : new Set();
    if (!this.overnight && this.statusCapabilities.get(owner) === 'unsupported') next.statuses.clear();
    const previous = this.owners.get(owner);
    if (previous && CHANNELS.every(channel => next[channel].size === previous[channel].size && [...next[channel]].every(value => previous[channel].has(value)))) return;
    this.ownerErrors.delete(owner);
    this.owners.set(owner, next);
    if (this.overnight) {
      this.reportStatusCapability(owner, next.statuses.size ? 'unsupported' : 'disabled');
    } else if (this.statusCapabilities.get(owner) !== 'unsupported') {
      this.reportStatusCapability(owner, next.statuses.size === 0 ? 'disabled' : [...next.statuses].every(symbol => this.subscriptions.statuses.has(symbol)) ? 'supported' : 'pending');
    }
    if (this.authenticated && !this.waitingForSubscription) this.reconcileSubscriptions();
  }

  removeOwner(owner: string): void {
    this.owners.delete(owner);
    this.ownerErrors.delete(owner);
    this.statusCapabilities.delete(owner);
    if (this.authenticated && !this.waitingForSubscription) this.reconcileSubscriptions();
  }

  ownerSubscriptionError(owner: string): string | null { return this.ownerErrors.get(owner) ?? null; }
  statusCapability(owner: string): StatusCapability { return this.statusCapabilities.get(owner) ?? 'disabled'; }

  private reportStatusCapability(owner: string, capability: StatusCapability): void {
    if (this.statusCapabilities.get(owner) === capability) return;
    this.statusCapabilities.set(owner, capability);
    this.handlers.onStatusCapability?.(owner, capability);
    for (const listener of this.listeners) listener.onStatusCapability?.(owner, capability);
  }

  addListener(listener: Partial<StreamHandlers>): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private desiredSubscriptions(): Subscription {
    const desired = emptySubscription();
    for (const channel of ['trades', 'quotes', 'bars'] as const) for (const symbol of this.desired) desired[channel].add(symbol);
    for (const owner of this.owners.values()) for (const channel of CHANNELS) {
      // Overnight feeds provide the core price channels; retain daytime-only requests for the next session.
      if (this.overnight && (channel === 'updatedBars' || channel === 'statuses')) continue;
      for (const symbol of owner[channel]) desired[channel].add(symbol);
    }
    return desired;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.active = false;
    this.clearTimers();
    this.closeSocket();
    this.rejectWaiters('The real-time connection was closed.');
    this.keyId = ''; this.secretKey = '';
    this.desired.clear();
    this.owners.clear(); this.ownerErrors.clear(); this.statusCapabilities.clear();
    this.report('disconnected', 'Real-time data disconnected.');
    this.listeners.clear();
  }

  private report(status: StreamStatus, message: string): void {
    this.status = status;
    this.handlers.onStatus(status, message);
    for (const listener of this.listeners) listener.onStatus?.(status, message);
  }

  private clean(message: string): string {
    for (const key of [this.keyId, this.secretKey]) if (key) message = message.split(key).join('[redacted]');
    return message.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 240);
  }

  private rejectWaiters(message: string): void {
    this.waiters.splice(0).forEach(waiter => waiter.reject(new Error(message)));
  }

  private clearTimers(): void {
    clearTimeout(this.phaseTimer); clearTimeout(this.retryTimer);
    this.phaseTimer = undefined; this.retryTimer = undefined;
    this.timeoutPhase = '';
  }

  private armTimeout(phase: string): void {
    if (this.phaseTimer !== undefined && this.timeoutPhase === phase) return;
    clearTimeout(this.phaseTimer);
    this.timeoutPhase = phase;
    this.phaseTimer = setTimeout(() => this.fail(`Real-time ${phase} timed out. Reconnect to try again.`), TIMEOUT);
  }

  private closeSocket(): void {
    const socket = this.socket;
    this.socket = null;
    this.authenticated = false;
    this.waitingForSubscription = false;
    this.pendingCommand = null;
    this.subscriptions = emptySubscription();
    for (const [owner, requested] of this.owners) if (requested.statuses.size) this.reportStatusCapability(owner, this.overnight ? 'unsupported' : 'pending');
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close(1000, 'Terminal disconnected');
  }

  private openSocket(): void {
    if (!this.active || this.disposed) return;
    this.closeSocket();
    this.report('connecting', 'Connecting to Alpaca real-time data…');
    if (!this.active || this.disposed) return;
    this.armTimeout('connection');
    let socket: WebSocket;
    try { socket = new WebSocket(this.endpoint); }
    catch { this.disconnected('Unable to open the real-time connection.'); return; }
    this.socket = socket;
    socket.addEventListener('message', event => {
      if (this.socket !== socket || !this.active || this.disposed) return;
      if (typeof event.data !== 'string') { this.fail('Alpaca returned an unsupported real-time data frame.'); return; }
      let frames: unknown;
      try { frames = JSON.parse(event.data); }
      catch { this.fail('Alpaca returned malformed real-time data.'); return; }
      if (!Array.isArray(frames) || !frames.length) { this.fail('Alpaca returned an invalid real-time message.'); return; }
      for (const frame of frames) {
        if (this.socket !== socket || !this.active || this.disposed) return;
        if (!frame || typeof frame !== 'object' || Array.isArray(frame) || typeof frame.T !== 'string') { this.fail('Alpaca returned an invalid real-time message.'); return; }
        this.process(frame as Frame);
      }
    });
    socket.addEventListener('close', () => {
      if (this.socket === socket && this.active && !this.disposed) this.disconnected('Alpaca real-time connection closed.');
    });
    socket.addEventListener('error', () => {
      if (this.socket === socket && this.active && !this.disposed) this.disconnected('Cannot reach Alpaca real-time data.');
    });
  }

  private send(frame: Frame): boolean {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) { this.disconnected('Real-time connection is unavailable.'); return false; }
    try { this.socket.send(JSON.stringify(frame)); return true; }
    catch { this.disconnected('Unable to send the real-time subscription.'); return false; }
  }

  private process(frame: Frame): void {
    if (frame.T === 'error') {
      const descriptions: Record<number, string> = {
        400: 'Alpaca rejected the stream request or symbol format.',
        401: 'Real-time authentication is required.',
        402: 'Real-time authentication failed. Check your Alpaca credentials.',
        403: 'Alpaca rejected a duplicate real-time authentication.',
        404: 'Real-time authentication timed out.',
        405: 'Your Alpaca plan does not support this many streaming symbols. Reduce the watchlist.',
        406: 'Alpaca stream connection limit reached. Close another app or browser tab using these keys.',
        407: 'The real-time connection could not keep up with incoming market data.',
        409: `Your Alpaca subscription does not include the required ${this.feed.toUpperCase()} real-time feed. Check your market data plan.`,
        410: 'The real-time feed does not support the requested channels.',
        500: 'Alpaca real-time data is temporarily unavailable.',
      };
      const reason = typeof frame.code === 'number' ? descriptions[frame.code] : undefined;
      const detail = typeof frame.msg === 'string' ? this.clean(frame.msg) : '';
      if (frame.code === 410 && this.authenticated && this.pendingCommand?.action === 'subscribe' && Array.isArray(this.pendingCommand.statuses) && this.pendingCommand.statuses.length) {
        // Status access is separately entitled. Retry core scanner channels after removing only the optional request.
        for (const [owner, requested] of this.owners) if (requested.statuses.size) {
          requested.statuses.clear(); this.reportStatusCapability(owner, 'unsupported');
        }
        this.pendingCommand = null; this.waitingForSubscription = false;
        this.reconcileSubscriptions();
        return;
      }
      if ((frame.code === 405 || frame.code === 410) && this.owners.size && this.authenticated) {
        const message = this.clean(`${reason || 'Scanner subscriptions unavailable.'}${detail ? ` ${detail}` : ''}`);
        const owners = [...this.owners.keys()];
        this.owners.clear();
        this.waitingForSubscription = false;
        this.pendingCommand = null;
        for (const owner of owners) {
          this.ownerErrors.set(owner, message);
          this.handlers.onSubscriptionError?.(owner, message);
          for (const listener of this.listeners) listener.onSubscriptionError?.(owner, message);
        }
        this.reconcileSubscriptions();
        return;
      }
      this.fail(`${reason || 'Alpaca rejected the real-time request.'}${detail ? ` ${detail}` : ''}`);
      return;
    }
    if (frame.T === 'success') {
      if (frame.msg === 'connected' && this.status === 'connecting') {
        this.report('authenticating', 'Authenticating Alpaca real-time data…');
        if (!this.active || this.disposed) return;
        this.armTimeout('authentication');
        this.send({ action: 'auth', key: this.keyId, secret: this.secretKey });
      } else if (frame.msg === 'authenticated' && this.status === 'authenticating') {
        this.authenticated = true;
        this.reconcileSubscriptions();
      } else this.fail('Alpaca returned an unexpected real-time authentication response.');
      return;
    }
    if (frame.T === 'subscription') {
      // Empty optional channels may be omitted, but every requested set must be acknowledged explicitly.
      const desired = this.desiredSubscriptions();
      for (const channel of ['updatedBars', 'statuses'] as const) if (frame[channel] === undefined && desired[channel].size === 0) frame[channel] = [];
      if (!this.authenticated || !this.waitingForSubscription || CHANNELS.some(channel => !Array.isArray(frame[channel]) || !(frame[channel] as unknown[]).every(validSymbol))) {
        this.fail('Alpaca returned an invalid real-time subscription acknowledgment.'); return;
      }
      for (const channel of CHANNELS) this.subscriptions[channel] = new Set(frame[channel] as string[]);
      this.waitingForSubscription = false;
      this.pendingCommand = null;
      for (const [owner, requested] of this.owners) if (requested.statuses.size && [...requested.statuses].every(symbol => this.subscriptions.statuses.has(symbol))) this.reportStatusCapability(owner, 'supported');
      this.reconcileSubscriptions();
      return;
    }
    // Alpaca automatically attaches trade correction/cancel channels to trades.
    // These events are not new trades and must never be displayed as a new price.
    if (frame.T === 'c' || frame.T === 'x') return;
    if (!['t', 'q', 'b', 'u', 's'].includes(String(frame.T))) { this.fail('Alpaca returned an unexpected real-time message type.'); return; }
    if (!this.authenticated) return;
    if (!validSymbol(frame.S) || !isTimestamp(frame.t)) { this.fail('Alpaca returned invalid real-time price or timestamp data.'); return; }
    const channel: Channel = frame.T === 't' ? 'trades' : frame.T === 'q' ? 'quotes' : frame.T === 'u' ? 'updatedBars' : frame.T === 's' ? 'statuses' : 'bars';
    if (!this.subscriptions[channel].has(frame.S)) return;
    if (!(!['updatedBars', 'statuses'].includes(channel) && this.desired.has(frame.S)) && ![...this.owners.values()].some(owner => owner[channel].has(frame.S as string))) return;
    const mainReady = this.status === 'ready' && this.desired.has(frame.S);
    if (frame.T === 's') {
      if (typeof frame.sc !== 'string' || !frame.sc || typeof frame.sm !== 'string') return;
      const status = { symbol: frame.S, statusCode: this.clean(frame.sc), message: this.clean(frame.sm), timestamp: frame.t };
      this.handlers.onTradingStatus?.(status);
      for (const listener of this.listeners) listener.onTradingStatus?.(status);
      return;
    }
    if (frame.T === 't') {
      if (!isPrice(frame.p)) { this.fail('Alpaca returned an invalid real-time trade price.'); return; }
      const trade = { symbol: frame.S, price: frame.p, timestamp: frame.t };
      if (mainReady) this.handlers.onTrade(trade);
      for (const listener of this.listeners) listener.onTrade?.(trade);
    } else if (frame.T === 'q') {
      if ([frame.bp, frame.ap].some(price => price !== undefined && price !== null && price !== 0 && !isPrice(price))) { this.fail('Alpaca returned invalid real-time bid or ask data.'); return; }
      const quote = { symbol: frame.S, bid: isPrice(frame.bp) ? frame.bp : null, ask: isPrice(frame.ap) ? frame.ap : null, bidSize: isPrice(frame.bs) ? frame.bs : null, askSize: isPrice(frame.as) ? frame.as : null, timestamp: frame.t };
      if (mainReady) this.handlers.onQuote(quote);
      for (const listener of this.listeners) listener.onQuote?.(quote);
    } else {
      if (![frame.o, frame.h, frame.l, frame.c].every(isPrice) || typeof frame.v !== 'number' || !Number.isFinite(frame.v) || frame.v < 0) { this.fail('Alpaca returned an incomplete real-time candle.'); return; }
      const o = frame.o as number, h = frame.h as number, l = frame.l as number, c = frame.c as number;
      if (h < Math.max(o, l, c) || l > Math.min(o, h, c)) { this.fail('Alpaca returned an invalid real-time candle range.'); return; }
      const bar = { symbol: frame.S, t: frame.t, o, h, l, c, v: frame.v, vw: isPrice(frame.vw) ? frame.vw : null, revision: frame.T === 'u' };
      if (mainReady) this.handlers.onBar?.(bar);
      for (const listener of this.listeners) listener.onBar?.(bar);
    }
  }

  private reconcileSubscriptions(): void {
    if (!this.active || !this.authenticated || this.waitingForSubscription) return;
    const removed: Frame = { action: 'unsubscribe' };
    const added: Frame = { action: 'subscribe' };
    const desired = this.desiredSubscriptions();
    for (const channel of CHANNELS) {
      const remove = [...this.subscriptions[channel]].filter(symbol => !desired[channel].has(symbol));
      const add = [...desired[channel]].filter(symbol => !this.subscriptions[channel].has(symbol));
      if (remove.length) removed[channel] = remove;
      if (add.length) added[channel] = add;
    }
    const command = Object.keys(removed).length > 1 ? removed : Object.keys(added).length > 1 ? added : null;
    if (command) {
      this.waitingForSubscription = true;
      this.pendingCommand = command;
      this.report('subscribing', 'Waiting for Alpaca to confirm all real-time subscriptions…');
      if (!this.active || this.disposed) return;
      this.armTimeout('subscription');
      this.send(command);
      return;
    }
    clearTimeout(this.phaseTimer); this.phaseTimer = undefined; this.timeoutPhase = '';
    this.retryCount = 0;
    this.report('ready', 'Alpaca real-time trades, quotes, and bars connected.');
    this.waiters.splice(0).forEach(waiter => waiter.resolve());
  }

  private disconnected(reason: string): void {
    if (!this.active || this.disposed) return;
    clearTimeout(this.phaseTimer); this.phaseTimer = undefined; this.timeoutPhase = '';
    this.closeSocket();
    this.rejectWaiters(`${reason} Real-time subscriptions are not ready.`);
    if (this.retryCount >= MAX_RECONNECTS) { this.fail(`${reason} Automatic reconnect attempts exhausted. Reconnect your account to try again.`); return; }
    const delay = Math.min(1000 * 2 ** this.retryCount++, 30_000);
    this.report('disconnected', `${reason} Reconnecting in ${delay / 1000} seconds…`);
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => { this.retryTimer = undefined; this.openSocket(); }, delay);
  }

  private fail(message: string): void {
    this.active = false;
    this.clearTimers();
    this.closeSocket();
    const sanitized = this.clean(message);
    this.rejectWaiters(sanitized);
    this.report('error', sanitized);
  }
}
