import { tradingDate, fullTradingSession, FULL_SESSION_CALENDAR } from '../../core/exchange-session';
import { isOvernightTime } from '../../core/trading-session';
import type { ScannerCache } from '../../market/cache';
import type { ResearchQuote, ScannerAsset } from '../../core/market-data';
import type { DataReads } from '../../broker/reads';
import type { ScannerSession } from '../../scanner/types';
import { loadLiquiditySnapshot } from '../../market/universe';
import { canonicalSerialize } from './values';
import type { AccountScope } from '../../core/account';
import type { RobotSession, TemplateIdentity, Veto } from '../domain';
import { validSession, veto } from '../templates/common';
import { templates } from '../templates/registry';
import type { ResearchCapability } from '../templates/types';
import { identifier, instant, integer, object, oneOf, requireValue } from '../../core/validation';
import { validateScope } from '../validation';

/** Resource limits, not evidence/strategy performance thresholds. No minute-history or tuning here. */
export const UNIVERSE_LIMITS = Object.freeze({
  version: 1, assets: 600, candidates: 30, previousSessions: 20, calendarDays: 45,
  dailyBatches: 2, pagesPerBatch: 2, historyConcurrency: 2,
  refreshMs: 30_000, durationMs: 20_000, contextMaxAgeMs: 60_000,
});
type DataApi = Pick<DataReads, 'getCalendar' | 'getEligibleAssets' | 'getBars' | 'getResearchQuotes'>;
export interface UniverseContext {
  readonly scope: AccountScope;
  /** Changes on reconnect, including credential rotation for the same stable account. */
  readonly connectionGeneration: number;
  readonly tradingDate: string;
  readonly data: {
    readonly status: 'available' | 'unavailable' | 'disconnected';
    readonly feed: 'sip' | 'boats' | null;
    readonly asOf: string;
    readonly validUntil: string;
    readonly provenanceRef: string;
    readonly capabilities: readonly ResearchCapability[];
  };
}
export interface UniverseCandidate {
  readonly asset: Readonly<ScannerAsset>;
  readonly quote: Readonly<ResearchQuote> | null;
  readonly eligibility: readonly {
    readonly template: TemplateIdentity;
    readonly status: 'eligible' | 'blocked';
    readonly blocks: readonly Veto[];
  }[];
}
export interface UniverseSnapshot {
  readonly schemaVersion: 1;
  /** Caller-owned unique reference; this service does not persist or approve it. */
  readonly id: string;
  readonly scope: AccountScope;
  readonly connectionGeneration: number;
  readonly requestedAt: string;
  readonly asOf: string;
  readonly dataCutoff: string;
  readonly session: RobotSession;
  readonly previousSessions: readonly RobotSession[];
  readonly horizon: { readonly entryWindow: { readonly from: string; readonly to: string }; readonly intendedEnd: string };
  readonly data: UniverseContext['data'];
  readonly provenance: {
    readonly assets: { readonly source: 'alpaca:/v2/assets'; readonly asOf: string; readonly filter: 'active-tradable-non-OTC-us-equity' };
    readonly liquidity: { readonly source: 'alpaca:/v2/stocks/bars'; readonly feed: 'sip'; readonly adjustment: 'split'; readonly start: string; readonly end: string };
    readonly quotes: { readonly source: 'alpaca:/v2/stocks/snapshots'; readonly feed: 'sip' | 'boats'; readonly asOf: string };
  };
  readonly breadth: {
    readonly availableAssets: number; readonly inspectedAssets: number; readonly omittedAssets: number;
    readonly liquidAssets: number; readonly quotedAssets: number; readonly omittedLiquidAssets: number;
    readonly selection: 'symbol-ascending-cap-then-prior-session-dollar-volume';
  };
  readonly liquidity: readonly {
    readonly symbol: string; readonly listingId: string; readonly meanDailyDollars: number | null;
    readonly observedDates: readonly string[]; readonly asOf: string; readonly blocks: readonly Veto[];
  }[];
  readonly candidates: readonly UniverseCandidate[];
  readonly limits: typeof UNIVERSE_LIMITS;
}
export type UniverseResult =
  | { readonly status: 'available'; readonly snapshot: UniverseSnapshot }
  | { readonly status: 'blocked' | 'unavailable' | 'cancelled'; readonly blocks: readonly Veto[]; readonly session: RobotSession | null };

const iso = (time: number): string => new Date(time).toISOString();
const abortError = () => new DOMException('Research snapshot cancelled.', 'AbortError');
const unavailable = (status: 'blocked' | 'unavailable' | 'cancelled', code: string, reason: string, session: RobotSession | null = null): UniverseResult =>
  structuredClone({ status, blocks: [veto('data', code, reason)], session });

export function validateUniverseContext(value: UniverseContext): void {
  object(value, 'context', ['scope', 'connectionGeneration', 'tradingDate', 'data']);
  validateScope(value.scope); integer(value.connectionGeneration, 'connectionGeneration');
  instant(`${value.tradingDate}T00:00:00.000Z`, 'tradingDate');
  const data = value.data;
  object(data, 'data', ['status', 'feed', 'asOf', 'validUntil', 'provenanceRef', 'capabilities']);
  oneOf(data.status, ['available', 'unavailable', 'disconnected'], 'data.status');
  requireValue(data.feed === null || data.feed === 'sip' || data.feed === 'boats', 'data.feed', 'unsupported_feed');
  instant(data.asOf, 'data.asOf'); instant(data.validUntil, 'data.validUntil'); identifier(data.provenanceRef, 'data.provenanceRef');
  requireValue(data.asOf < data.validUntil, 'data', 'invalid_time_order');
  requireValue(Array.isArray(data.capabilities) && new Set(data.capabilities).size === data.capabilities.length, 'capabilities', 'invalid_capabilities');
  data.capabilities.forEach(capability => oneOf(capability, ['completed_5min_bars', 'observed_prices', 'bid_ask'], 'capability'));
}

/** Explicit read-only jobs. Inject the existing adapter/cache; never creates a client or polls on render. */
export class UniverseService {
  private context: UniverseContext | null = null;
  private generation = 0;
  private controller: AbortController | null = null;
  private lastStarted = -Infinity;
  constructor(private api: DataApi, private readonly cache: ScannerCache, private readonly now: () => number) {}

  /** Supply the matching adapter on account/reconnect changes; this service never owns its credentials/lifetime. */
  setContext(context: UniverseContext | null, api: DataApi = this.api): void {
    // Invalid replacement also cancels old work; never silently retains the previous connected context.
    try { if (context) validateUniverseContext(context); }
    catch (error) { this.cancel(); this.context = null; this.generation++; throw error; }
    if (api === this.api && context && this.context && canonicalSerialize(context) === canonicalSerialize(this.context)) return;
    this.cancel(); this.context = null; this.generation++;
    this.api = api;
    if (context) this.context = structuredClone(context);
  }
  cancel(): void { this.controller?.abort(); }
  dispose(): void { this.setContext(null); }

  async capture(id: string, signal?: AbortSignal): Promise<UniverseResult> {
    identifier(id, 'snapshot.id');
    if (signal?.aborted) return unavailable('cancelled', 'cancelled', 'Research was cancelled');
    const context = this.context;
    if (!context) return unavailable('unavailable', 'context_unavailable', 'Account and data context are required');
    const started = this.now();
    const api = this.api;
    const gate = this.contextGate(context, started);
    if (gate) return gate;
    if (this.controller && !this.controller.signal.aborted) return unavailable('blocked', 'research_busy', 'A snapshot job is already running');
    if (started < this.lastStarted + UNIVERSE_LIMITS.refreshMs) return unavailable('blocked', 'refresh_limited', 'Research refresh is limited to once per 30 seconds');
    this.lastStarted = started;
    const controller = new AbortController(), generation = this.generation;
    this.controller = controller;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, UNIVERSE_LIMITS.durationMs);
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const active = () => {
      if (controller.signal.aborted || generation !== this.generation) throw abortError();
      const current = this.now();
      if (!Number.isFinite(current) || current < started || current - started >= UNIVERSE_LIMITS.durationMs
        || tradingDate(current) !== context.tradingDate) { controller.abort(); throw abortError(); }
    };
    // Even an adapter which ignores AbortSignal cannot keep the public job pending or publish late output.
    const read = async <T>(action: () => Promise<T>): Promise<T> => {
      active();
      let abortRead!: () => void;
      const cancelled = new Promise<never>((_resolve, reject) => { abortRead = () => reject(abortError()); controller.signal.addEventListener('abort', abortRead, { once: true }); });
      try { const value = await Promise.race([action(), cancelled]); active(); return structuredClone(value); }
      finally { controller.signal.removeEventListener('abort', abortRead); }
    };
    let stage = 'calendar', session: RobotSession | null = null;
    try {
      const startDate = iso(Date.parse(`${context.tradingDate}T00:00:00.000Z`) - UNIVERSE_LIMITS.calendarDays * 86_400_000).slice(0, 10);
      const calendar = await read(() => api.getCalendar(startDate, context.tradingDate, controller.signal));
      const calendarAsOf = iso(this.now());
      const robotSession = (value: ScannerSession): RobotSession => ({ calendarId: 'alpaca-us-equity', tradingDate: value.date,
        timeZone: 'America/New_York', openAt: iso(value.open), closeAt: iso(value.close), calendarAsOf,
        provenanceRef: `alpaca-calendar/${startDate}/${context.tradingDate}/${calendarAsOf}` });
      requireValue(Array.isArray(calendar) && new Set(calendar.map(value => value.date)).size === calendar.length
        && calendar.every(value => value.date >= startDate && value.date <= context.tradingDate && validSession(robotSession(value))), 'calendar', 'invalid_calendar');
      const today = calendar.find(value => value.date === context.tradingDate);
      if (!today) return unavailable('blocked', 'no_exchange_session', 'The exchange calendar has no session on this date');
      const full = fullTradingSession(today);
      session = { ...robotSession(full), calendarId: FULL_SESSION_CALENDAR };
      if (started < full.open || this.now() >= full.close) return unavailable('blocked', 'trading_session_closed', 'Research requires an open 24/5 trading session', session);
      const previous = calendar.filter(value => value.close < today.open).sort((a, b) => a.open - b.open).slice(-UNIVERSE_LIMITS.previousSessions);
      if (previous.length !== UNIVERSE_LIMITS.previousSessions) return unavailable('unavailable', 'liquidity_calendar_incomplete', 'Twenty preceding exchange sessions are required for liquidity inputs', session);

      stage = 'assets';
      const allAssets = await read(() => api.getEligibleAssets(controller.signal));
      const assetsAsOf = iso(this.now());
      requireValue(Array.isArray(allAssets) && new Set(allAssets.map(value => value.symbol)).size === allAssets.length
        && allAssets.every(value => /^[A-Z][A-Z0-9.-]{0,14}$/.test(value.symbol) && typeof value.id === 'string' && value.id.length > 0
          && typeof value.name === 'string' && typeof value.exchange === 'string' && value.exchange.length > 0 && value.exchange !== 'OTC'), 'assets', 'invalid_universe');
      const assets = allAssets.filter(asset => !isOvernightTime(started) || asset.overnightTradable === true).sort((a, b) => a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0).slice(0, UNIVERSE_LIMITS.assets);
      stage = 'liquidity';
      const liquidity = assets.length ? await read(() => loadLiquiditySnapshot({
        getBars: (symbols, options, abortSignal) => api.getBars(symbols, { ...options, maxPagesPerBatch: UNIVERSE_LIMITS.pagesPerBatch }, abortSignal),
      }, this.cache, assets, previous, today, assets.length, this.now, controller.signal)) : { symbols: [], observations: [] };
      const observations = liquidity.observations.map(value => ({ symbol: value.symbol, listingId: assets.find(asset => asset.symbol === value.symbol)!.id,
        meanDailyDollars: value.meanDailyDollars, observedDates: value.observedDates, asOf: iso(value.asOf),
        blocks: value.meanDailyDollars === null || value.observedDates.length !== previous.length
          ? [veto('data', 'liquidity_incomplete', 'Positive observed dollar volume is required for every preceding session')] : [],
      }));
      const usable = new Set(observations.filter(value => !value.blocks.length).map(value => value.symbol));
      const liquidSymbols = liquidity.symbols.filter(symbol => usable.has(symbol));
      const selected = liquidSymbols.slice(0, UNIVERSE_LIMITS.candidates);
      stage = 'quotes';
      const quotes = selected.length ? await read(() => api.getResearchQuotes(selected, controller.signal)) : {};
      const cutoff = this.now();
      active();
      const finalGate = this.contextGate(context, cutoff);
      if (finalGate) return finalGate;
      if (cutoff >= full.close) return unavailable('blocked', 'trading_session_closed', 'The trading session ended during research', session);
      const candidates = selected.map(symbol => {
        const input = { session: session!, dataCutoff: iso(cutoff), capabilities: context.data.capabilities, quote: quotes[symbol] ?? null };
        return { asset: assets.find(asset => asset.symbol === symbol)!, quote: input.quote,
          eligibility: templates.map(template => {
            const blocks = template.discoveryEligibility(input);
            return { template: template.identity, status: blocks.length ? 'blocked' as const : 'eligible' as const, blocks };
          }),
        };
      });
      return structuredClone({ status: 'available', snapshot: {
        schemaVersion: 1, id, scope: context.scope, connectionGeneration: context.connectionGeneration,
        requestedAt: iso(started), asOf: iso(cutoff), dataCutoff: iso(cutoff), session, previousSessions: previous.map(robotSession),
        horizon: { entryWindow: { from: iso(cutoff), to: session.closeAt }, intendedEnd: session.closeAt },
        data: context.data,
        provenance: {
          assets: { source: 'alpaca:/v2/assets', asOf: assetsAsOf, filter: 'active-tradable-non-OTC-us-equity' },
          liquidity: { source: 'alpaca:/v2/stocks/bars', feed: 'sip', adjustment: 'split', start: iso(previous[0].open - 12 * 3_600_000), end: iso(today.open) },
          quotes: { source: 'alpaca:/v2/stocks/snapshots', feed: context.data.feed!, asOf: iso(cutoff) },
        },
        breadth: { availableAssets: allAssets.length, inspectedAssets: assets.length, omittedAssets: allAssets.length - assets.length,
          liquidAssets: liquidSymbols.length, quotedAssets: selected.length, omittedLiquidAssets: liquidSymbols.length - selected.length,
          selection: 'symbol-ascending-cap-then-prior-session-dollar-volume' },
        liquidity: observations, candidates, limits: UNIVERSE_LIMITS,
      } });
    } catch {
      if (controller.signal.aborted || generation !== this.generation) return unavailable(timedOut ? 'unavailable' : 'cancelled', timedOut ? 'research_timeout' : 'generation_cancelled', timedOut ? 'The bounded research deadline elapsed' : 'Research was cancelled or its account/session generation changed');
      // Never expose provider errors, credentials, request URLs or a partial batch as a connected snapshot.
      return unavailable('unavailable', `${stage}_unavailable`, `Required ${stage} inputs could not be loaded or validated`, session);
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (this.controller === controller) this.controller = null;
    }
  }

  private contextGate(context: UniverseContext, now: number): UniverseResult | null {
    if (!Number.isFinite(now) || !Number.isFinite(new Date(now).getTime())) return unavailable('unavailable', 'clock_unavailable', 'A valid UTC clock is required');
    if (context.scope.broker !== 'alpaca') return unavailable('blocked', 'unsupported_broker', 'Research requires an Alpaca account scope');
    if (context.data.status === 'disconnected') return unavailable('unavailable', 'disconnected', 'A connected market-data context is required');
    if (context.data.status !== 'available' || context.data.feed !== (isOvernightTime(now) ? 'boats' : 'sip')) return unavailable('unavailable', 'feed_unavailable', 'Current real-time SIP or overnight BOATS data is required');
    if (now < Date.parse(context.data.asOf) || now >= Date.parse(context.data.validUntil) || now - Date.parse(context.data.asOf) > UNIVERSE_LIMITS.contextMaxAgeMs) return unavailable('unavailable', 'data_context_stale', 'The data-capability assessment is stale or outside its validity window');
    if (tradingDate(now) !== context.tradingDate) return unavailable('blocked', 'session_generation_changed', 'The context must match the current New York exchange date');
    return null;
  }
}
