import { tradingDate, currentSessionSegment, sessionSegment } from '../core/exchange-session';
import type { DataReads, MarketStream } from '../broker/reads';
import type { ScannerAsset } from '../core/market-data';
import { ScannerBarStore, ScannerCache } from '../market/cache';
import { loadLiquidityUniverse } from '../market/universe';
import { DEFAULT_SCANNER_CONFIG, validateScannerConfig, buildVolumeProfile, calculateWindow, completedSessionBars, evaluateScanner, QuoteSampler } from './engine';
import type { ScannerBar, ScannerConfig, ScannerEvaluation, ScannerSession, VolumeProfile } from './types';
import { createScannerState, updateScannerState, type ScannerState } from './state';

export interface ScannerRow { evaluation: ScannerEvaluation; state: 'Clean uptrend' | 'Fading' | 'Candidate' | 'Not qualified' | 'Data unavailable' | 'Loading history' | 'Warming quotes' | 'Forming' | 'Not live'; bars: ScannerBar[]; confirmed?: boolean }
export interface ScannerRecentRow extends ScannerRow { lastQualifiedAt: number }
export interface ScannerDiagnostics {
  universeSize: number; baseUniverseSize: number; mostActiveCount: number; moversCount: number;
  historyReady: number; historyPending: number; quoteShortlistSize: number; qualifyingCount: number;
  cacheHits: number; barLagSeconds: number | null; quoteAgeSeconds: number | null;
  lastDiscovery: number | null; lastRanking: number | null; exclusionCounts: Record<string, number>;
  optionalStatus: string; bootstrapProgress: string; warnings: string[];
  liquidityProcessed?: number; liquidityTotal?: number; liquidityComplete?: boolean;
  barsReady?: number; historyUnrequested?: number; worstUniverseBarLagSeconds?: number | null;
}
export interface ScannerSnapshot {
  status: 'disconnected' | 'loading' | 'forming' | 'live' | 'closed' | 'error';
  message: string; session: ScannerSession | null; rows: ScannerRow[];
  candidates?: ScannerRow[]; recentRows?: ScannerRecentRow[];
  /** Complete evaluation coverage for retained reviews; admission is explicit, independent of rank. */
  reviewRows?: ScannerRow[];
  diagnostics: ScannerDiagnostics; config: ScannerConfig;
}
interface CachedProfile { fingerprint: string; profile: VolumeProfile }
interface SelectionRecord { evaluationTime: number; recordedAt: number; configVersion: number; entries: ScannerEvaluation[]; changes: string[] }
const OWNER = 'clean-uptrends';
const MINUTE = 60_000, DAY = 86_400_000;
const emptyDiagnostics = (): ScannerDiagnostics => ({
  universeSize: 0, baseUniverseSize: 0, mostActiveCount: 0, moversCount: 0, historyReady: 0,
  historyPending: 0, quoteShortlistSize: 0, qualifyingCount: 0, cacheHits: 0, barLagSeconds: null,
  quoteAgeSeconds: null, lastDiscovery: null, lastRanking: null, exclusionCounts: {},
  optionalStatus: 'Unavailable — halt status requires separate Alpaca capability; freshness checks remain active.',
  bootstrapProgress: '', warnings: [],
  liquidityProcessed: 0, liquidityTotal: 0, liquidityComplete: false,
});
const isoDate = (now: number): string => new Date(now).toISOString().slice(0, 10);
const batch = <T>(items: T[], size: number): T[][] => Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size));

/** One scanner per existing terminal connection. This class has no order API. */
export class Scanner {
  snapshot: ScannerSnapshot;
  private readonly api: DataReads;
  private cache: ScannerCache;
  private calendar: ScannerSession[] = [];
  private assets = new Map<string, ScannerAsset>();
  private universe: string[] = [];
  private discoverySymbols = new Set<string>();
  private reviewSymbols = new Set<string>();
  private base: string[] = [];
  private quotes = new Map<string, QuoteSampler>();
  private profiles = new Map<string, VolumeProfile>();
  private fingerprints: Record<string, string> = {};
  private tradingStatuses = new Map<string, { time: number; halted: boolean }>();
  private previousClose: Record<string, number | null> = {};
  private store: ScannerBarStore | null = null;
  private state: ScannerState = createScannerState();
  private evaluations: ScannerEvaluation[] = [];
  private records: SelectionRecord[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  private unsubscribe: (() => void) | undefined;
  private controller = new AbortController();
  private running = false;
  private disposed = false;
  private busy = false;
  private ready = true;
  private recovering = false;
  private subscriptionFailed = false;
  private lastCycle = 0;
  private calendarDate = '';
  private watermark = 0;
  private dirty = false;
  private generation = 0;
  private historyAttempts = new Map<string, number>();
  private backfillAttempts = new Map<string, { gap: number; checkedAt: number }>();
  private universeJob: { controller: AbortController; promise: Promise<void> } | null = null;
  private universeRetryAt = 0;
  private universeWarning = '';
  private cycleRequested = false;

  constructor(private readonly stream: MarketStream,
    private readonly onChange: () => void, private readonly now: () => number,
    dependencies: { api: DataReads; cache?: ScannerCache; config?: ScannerConfig }) {
    this.api = dependencies.api;
    this.cache = dependencies?.cache ?? new ScannerCache();
    let config = dependencies?.config ?? DEFAULT_SCANNER_CONFIG;
    if (!dependencies?.config) {
      try { const saved = JSON.parse(localStorage.getItem('paca.current.scanner.config') || 'null'); if (saved) config = validateScannerConfig({ ...DEFAULT_SCANNER_CONFIG, ...saved }); } catch { /* Invalid preferences use documented defaults. */ }
    }
    this.snapshot = { status: 'disconnected', message: 'Connect to real-time SIP and overnight BOATS to scan 24/5.', session: null, rows: [], candidates: [], recentRows: [], reviewRows: [], diagnostics: emptyDiagnostics(), config: validateScannerConfig(config) };
  }

  start(): void {
    if (this.running || this.disposed) return;
    this.running = true;
    this.unsubscribe = this.stream.addListener({
      onStatus: (status, message) => {
        if (this.disposed || !this.snapshot.config.enabled) return;
        if (status === 'ready') {
          if (!this.ready) { this.ready = true; this.recovering = true; this.lastCycle = 0; void this.cycle(); }
        } else if (status === 'disconnected' || status === 'error' || status === 'connecting' || status === 'authenticating') {
          this.ready = false; this.recovering = true; this.quotes.clear(); this.invalidateAll();
          this.publish('error', `${message} Scanner results are not live.`);
        }
      },
      onSubscriptionError: (owner, message) => {
        if (owner !== OWNER) return;
        this.subscriptionFailed = true; this.quotes.clear(); this.invalidateAll(); this.publish('error', message);
      },
      onStatusCapability: (owner, capability) => {
        if (owner !== OWNER) return;
        this.snapshot.diagnostics.optionalStatus = capability === 'supported' ? 'Supported — known halts invalidate immediately; absent messages do not prove normal trading.'
          : capability === 'pending' ? 'Verifying optional status subscription.'
          : capability === 'unsupported' ? 'Unavailable for this account — independent freshness checks remain active.'
          : 'Disabled — optional capability has not been requested; freshness checks remain active.';
        this.onChange();
      },
      onTradingStatus: status => {
        const time = Date.parse(status.timestamp), session = this.snapshot.session;
        if (!session || !this.universe.includes(status.symbol) || !Number.isFinite(time) || time < session.open || time > this.now() + 1000 || time < (this.tradingStatuses.get(status.symbol)?.time ?? 0)) return;
        // CTA and UTP code sets from Alpaca's documented status schema. Quotation-only
        // resumptions ('Q') do not establish that executions have resumed.
        const halted = ['2', 'F', 'H', 'P'].includes(status.statusCode);
        const resumed = ['3', 'T'].includes(status.statusCode);
        if (!halted && !resumed) return;
        this.tradingStatuses.set(status.symbol, { time, halted });
        if (halted) { this.hardInvalidate(status.symbol, `Known trading halt (${status.statusCode}).`); this.onChange(); }
        else { this.lastCycle = 0; this.dirty = true; }
      },
      onQuote: quote => this.quotes.get(quote.symbol)?.ingest({ t: quote.timestamp, bp: quote.bid ?? NaN, ap: quote.ask ?? NaN, bs: quote.bidSize ?? NaN, as: quote.askSize ?? NaN }),
      onBar: bar => { if (this.universe.includes(bar.symbol) && this.store?.mergeLive(bar.symbol, { ...bar, vw: bar.vw ?? null }, bar.revision ?? false)) this.dirty = true; },
    });
    this.timer = setInterval(() => this.tick(), 1000);
    void this.cycle();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.generation++; this.controller.abort(); clearInterval(this.timer);
    this.stopUniverseLoad();
    this.unsubscribe?.(); this.stream.removeOwner(OWNER); this.quotes.clear();
  }

  /** Watching retains bars, volume history and quotes even outside discovery coverage. */
  setReviewSymbols(symbols: string[]): void {
    const next = new Set(symbols.filter(symbol => /^[A-Z][A-Z0-9.\-]{0,19}$/.test(symbol)));
    if (next.size === this.reviewSymbols.size && [...next].every(symbol => this.reviewSymbols.has(symbol))) return;
    this.reviewSymbols = next;
    if (this.running && this.snapshot.config.enabled) this.requestUniverseEvaluation();
  }

  updateConfig(patch: Partial<ScannerConfig>): void {
    const config = validateScannerConfig({ ...this.snapshot.config, ...patch, version: this.snapshot.config.version + 1 });
    this.snapshot = { ...this.snapshot, config, rows: [], candidates: [], recentRows: [], reviewRows: [] };
    try { localStorage.setItem('paca.current.scanner.config', JSON.stringify(config)); } catch { /* Preferences remain valid for this tab. */ }
    this.generation++; this.controller.abort(); this.controller = new AbortController();
    this.stopUniverseLoad(); this.universeRetryAt = 0; this.universeWarning = '';
    this.snapshot.diagnostics.liquidityComplete = false; this.snapshot.diagnostics.liquidityProcessed = 0;
    this.state = createScannerState(); this.watermark = 0; this.dirty = true; this.subscriptionFailed = false;
    this.profiles.clear(); this.quotes.clear(); this.historyAttempts.clear(); this.base = []; this.lastCycle = 0;
    this.stream.removeOwner(OWNER);
    if (!config.enabled) this.publish('disconnected', 'Scanner paused. Manual watchlists are available.');
    else { this.publish('loading', 'Revalidating scanner settings…'); void this.cycle(); }
  }

  private tick(): void {
    if (this.disposed || !this.snapshot.config.enabled) return;
    const now = this.now(), session = this.snapshot.session;
    const recent = this.snapshot.recentRows ?? [];
    const retained = recent.filter(row => now - row.lastQualifiedAt < 15 * MINUTE);
    if (retained.length !== recent.length) { this.snapshot.recentRows = retained; this.onChange(); }
    if (!session || now < session.open || now >= session.close || this.calendarDate !== tradingDate(now)) {
      if (session && now >= session.close && this.snapshot.status !== 'closed') {
        this.stopUniverseLoad();
        this.stream.removeOwner(OWNER); this.quotes.clear();
        this.snapshot.diagnostics.qualifyingCount = 0;
        this.publish('closed', `Trading session closed. ${session.date} · Not live.`);
      }
      if (now - this.lastCycle >= 60_000) void this.cycle();
      return;
    }
    if (!this.ready || this.subscriptionFailed) return;
    for (const sampler of this.quotes.values()) sampler.sample(now);
    if (!this.recovering && this.store && this.universe.length) {
      const next = Math.floor((now - this.snapshot.config.barGraceSeconds * 1000) / MINUTE) * MINUTE;
      if (next >= session.open && (next !== this.watermark || this.dirty)) this.rank(next);
      this.invalidateBadQuotes(now);
    }
    if (now - this.lastCycle >= this.snapshot.config.discoveryIntervalSeconds * 1000) void this.cycle();
  }

  private async cycle(): Promise<void> {
    if (this.busy || this.disposed || !this.snapshot.config.enabled || this.subscriptionFailed) return;
    this.busy = true;
    const generation = this.generation, signal = this.controller.signal;
    const active = () => {
      if (this.disposed || signal.aborted || generation !== this.generation) throw new DOMException('Scanner work cancelled', 'AbortError');
      if (this.subscriptionFailed || !this.ready) throw new Error('Scanner subscriptions are unavailable.');
      if (this.snapshot.session && this.now() >= this.snapshot.session.close) throw new Error('Trading session closed during scanner refresh.');
    };
    this.lastCycle = this.now();
    try {
      const now = this.now(), date = tradingDate(now);
      if (date !== this.calendarDate || !this.calendar.length) {
        this.calendar = await this.api.getCalendar(isoDate(now - 120 * DAY), isoDate(now + 7 * DAY), signal);
        if (this.disposed || signal.aborted || generation !== this.generation) return;
        this.calendarDate = date;
      }
      const regular = this.calendar.find(value => value.date === date);
      const session = regular && currentSessionSegment(regular, now);
      if (!session || now < session.open || now >= session.close) {
        this.stopUniverseLoad();
        this.stream.removeOwner(OWNER); this.quotes.clear();
        this.snapshot.diagnostics.qualifyingCount = 0;
        this.publish('closed', `Trading session closed.${this.snapshot.session ? ` ${this.snapshot.session.date} · Not live.` : ''}`); return;
      }
      if (!this.ready) return;
      if (session.open !== this.snapshot.session?.open) this.newSession(session);
      if (!this.assets.size) {
        this.publish('loading', 'Loading eligible stocks and discovery feeds…');
        const assets = await this.api.getEligibleAssets(signal); active();
        this.assets = new Map(assets.filter(asset => session.mode !== 'overnight' || asset.overnightTradable === true).map(asset => [asset.symbol, asset]));
        this.snapshot.diagnostics.liquidityTotal = assets.length;
      }
      let discovery: Awaited<ReturnType<DataReads['getDiscovery']>>;
      try { discovery = await this.api.getDiscovery(session, this.now(), signal); }
      catch (error) { active(); discovery = { symbols: [], warnings: [this.errorText(error)], updatedAt: null, mostActiveCount: 0, moversCount: 0 }; }
      active();
      // Evaluate discovery hints immediately while broad liquidity ordering runs
      // independently. Loading thousands of daily histories must not block it.
      this.startUniverseLoad(session);
      const discoveryUniverse = [...new Set([...this.base, ...discovery.symbols])].filter(symbol => this.assets.has(symbol));
      this.discoverySymbols = new Set(discoveryUniverse);
      const nextUniverse = [...new Set([...discoveryUniverse, ...this.reviewSymbols])].filter(symbol => this.assets.has(symbol));
      for (const symbol of this.universe) if (!nextUniverse.includes(symbol)) {
        this.hardInvalidate(symbol, 'No longer in the discovery universe.');
        this.quotes.delete(symbol);
        if (!this.state.recentRows.some(row => row.symbol === symbol)) delete this.state.entries[symbol];
        this.profiles.delete(symbol); this.historyAttempts.delete(symbol); this.tradingStatuses.delete(symbol);
        delete this.previousClose[symbol];
      }
      this.universe = nextUniverse;
      // Monitoring a saved review must not alter discovery ranking or its shortlist.
      this.state.visible = this.state.visible.filter(symbol => this.discoverySymbols.has(symbol));
      for (const symbol of Object.keys(this.state.entries)) if (!this.discoverySymbols.has(symbol)) delete this.state.entries[symbol];
      this.store!.retain(new Set(this.universe));
      this.snapshot.diagnostics = { ...this.snapshot.diagnostics, universeSize: this.universe.length, baseUniverseSize: this.base.length,
        mostActiveCount: discovery.mostActiveCount, moversCount: discovery.moversCount,
        lastDiscovery: discovery.updatedAt === null ? this.snapshot.diagnostics.lastDiscovery : this.now(), warnings: [...discovery.warnings, ...(this.universeWarning ? [this.universeWarning] : [])] };
      if (!this.universe.length) {
        this.publish(this.snapshot.diagnostics.liquidityComplete ? 'live' : 'loading', this.snapshot.diagnostics.liquidityComplete
          ? 'No eligible stocks have usable daily liquidity data.' : 'Building the liquid stock universe in the background. Discovery feeds have no eligible candidates yet.');
        return;
      }
      this.subscriptions();
      // Corporate-action responses are complete before any cached share-volume profile is trusted.
      const fingerprints = await this.api.getSplitFingerprint(this.universe, isoDate(now - 120 * DAY), date, signal); active();
      for (const symbol of this.universe) {
        if (this.fingerprints[symbol] !== undefined && this.fingerprints[symbol] !== fingerprints[symbol]) {
          this.profiles.delete(symbol); this.historyAttempts.delete(symbol); this.cache.invalidate(`profile:${symbol}:`, this.now());
          this.hardInvalidate(symbol, 'Corporate action changed; rebuilding split-adjusted history.');
        }
      }
      this.fingerprints = fingerprints;
      for (const symbol of this.universe) if (fingerprints[symbol]?.startsWith('unsupported-unit-split:')) {
        this.profiles.delete(symbol); this.hardInvalidate(symbol, 'Unit split: comparable historical share volume is unavailable.');
      }
      await this.backfill(this.universe, session, signal, active); active();
      this.recovering = false;
      const evaluationTime = Math.floor((this.now() - this.snapshot.config.barGraceSeconds * 1000) / MINUTE) * MINUTE;
      this.selectQuotes(evaluationTime);
      if (this.quotes.size) {
        const snapshots = await this.api.getSnapshots([...this.quotes.keys()], signal); active();
        for (const [symbol, snapshot] of Object.entries(snapshots)) this.previousClose[symbol] = snapshot.previousClose;
      }
      this.rank(evaluationTime);
      await this.loadHistory(session, signal, active); active();
      this.snapshot.diagnostics.bootstrapProgress = '';
      this.rank(Math.floor((this.now() - this.snapshot.config.barGraceSeconds * 1000) / MINUTE) * MINUTE);
    } catch (error) {
      if (!signal.aborted && !this.disposed && generation === this.generation && this.snapshot.session && this.now() >= this.snapshot.session.close) {
        this.stopUniverseLoad();
        this.stream.removeOwner(OWNER); this.quotes.clear();
        this.snapshot.diagnostics.qualifyingCount = 0;
        this.publish('closed', `Trading session closed. ${this.snapshot.session.date} · Not live.`);
      } else if (!signal.aborted && !this.disposed && generation === this.generation) {
        this.recovering = true; this.invalidateAll(); this.publish('error', `${this.errorText(error)} Scanner results are not live.`);
      }
    } finally {
      this.busy = false;
      if (this.cycleRequested && !this.disposed && this.snapshot.config.enabled) {
        this.cycleRequested = false; this.lastCycle = 0;
        queueMicrotask(() => { if (this.ready && !this.disposed) void this.cycle(); });
      }
    }
  }

  private newSession(session: ScannerSession): void {
    this.stopUniverseLoad(); this.universeRetryAt = 0; this.universeWarning = ''; this.cycleRequested = false;
    this.snapshot.session = session; this.snapshot.rows = []; this.snapshot.candidates = []; this.snapshot.recentRows = []; this.snapshot.reviewRows = []; this.snapshot.diagnostics = emptyDiagnostics();
    this.store = new ScannerBarStore(session.open, session.close); this.state = createScannerState();
    this.base = []; this.universe = []; this.discoverySymbols.clear(); this.assets.clear(); this.profiles.clear(); this.quotes.clear(); this.historyAttempts.clear(); this.backfillAttempts.clear();
    this.fingerprints = {}; this.previousClose = {}; this.watermark = 0; this.evaluations = []; this.records = [];
    this.tradingStatuses.clear();
  }

  private stopUniverseLoad(): void {
    this.universeJob?.controller.abort(); this.universeJob = null;
  }

  private requestUniverseEvaluation(): void {
    this.lastCycle = 0;
    if (this.busy) this.cycleRequested = true;
    else if (this.ready && !this.disposed) queueMicrotask(() => void this.cycle());
  }

  private startUniverseLoad(session: ScannerSession): void {
    if (this.universeJob || this.snapshot.diagnostics.liquidityComplete || this.now() < this.universeRetryAt) return;
    const previous = this.calendar.filter(value => value.close < session.open).slice(-this.snapshot.config.baselineTargetSessions);
    const generation = this.generation, parentSignal = this.controller.signal;
    const job = { controller: new AbortController(), promise: Promise.resolve() };
    this.universeJob = job;
    const abort = () => job.controller.abort();
    parentSignal.addEventListener('abort', abort, { once: true });
    const current = () => !this.disposed && !job.controller.signal.aborted && generation === this.generation && this.snapshot.session?.date === session.date && this.now() < session.close;
    let firstAvailable = this.base.length > 0;
    job.promise = loadLiquidityUniverse(this.api, this.cache, [...this.assets.values()], previous, session,
      this.snapshot.config.baseUniverseSize, this.now, job.controller.signal, progress => {
        if (!current()) return;
        this.base = progress.symbols;
        this.snapshot.diagnostics.liquidityProcessed = progress.processed;
        this.snapshot.diagnostics.liquidityTotal = progress.total;
        this.snapshot.diagnostics.liquidityComplete = progress.complete;
        // Use the first actual base candidates even if discovery feeds are empty.
        // Further partial batches do not churn subscriptions or starve history.
        if (!firstAvailable && progress.symbols.length) {
          firstAvailable = true;
          if (!this.universe.length) this.requestUniverseEvaluation();
        }
        this.onChange();
      }).then(symbols => {
        if (!current()) return;
        this.base = symbols;
        this.snapshot.diagnostics.liquidityComplete = true;
        this.universeWarning = '';
        this.requestUniverseEvaluation();
      }).catch(error => {
        if (!current()) return;
        this.universeRetryAt = this.now() + this.snapshot.config.discoveryIntervalSeconds * 1000;
        this.universeWarning = `Broad liquidity ordering paused: ${this.errorText(error)} Completed batches will be reused on retry.`;
        if (!this.snapshot.diagnostics.warnings.includes(this.universeWarning)) this.snapshot.diagnostics.warnings.push(this.universeWarning);
        if (!this.universe.length) this.publish('error', this.universeWarning);
        else this.onChange();
      }).finally(() => {
        parentSignal.removeEventListener('abort', abort);
        if (this.universeJob === job) this.universeJob = null;
      });
  }

  private async backfill(symbols: string[], session: ScannerSession, signal: AbortSignal, active: () => void): Promise<void> {
    const now = this.now();
    const end = Math.min(now, session.close);
    if (end <= session.open) return;
    const completedEnd = Math.max(session.open, Math.min(session.close, Math.floor((now - this.snapshot.config.barGraceSeconds * 1000) / MINUTE) * MINUTE));
    const recentStart = Math.max(session.open, completedEnd - 3 * MINUTE);
    const included = new Set(symbols);
    const ordered = [...new Set([...this.snapshot.rows.map(row => row.evaluation.symbol), ...this.quotes.keys(), ...symbols])].filter(symbol => included.has(symbol));
    for (const symbol of this.backfillAttempts.keys()) if (!included.has(symbol)) this.backfillAttempts.delete(symbol);
    const existing = ordered.filter(symbol => this.store!.bars(symbol).length > 0 || this.store!.coveredThrough(symbol) > session.open || this.backfillAttempts.has(symbol));
    const existingSet = new Set(existing);
    const firstGap = (symbol: string): number | null => {
      const times = new Set(this.store!.bars(symbol).map(bar => Date.parse(bar.t)));
      const start = session.mode && !this.recovering ? this.store!.coveredThrough(symbol) : session.open;
      for (let time = start; time < completedEnd; time += MINUTE) if (!times.has(time)) return time;
      return null;
    };
    const read = async (group: string[], start: number) => {
      const watermark = this.store!.watermark();
      const bars = await this.api.getBars(group, { start, end, timeframe: '1Min', ...(session.mode === 'overnight' ? { feed: 'boats' as const } : {}) }, signal); active();
      for (const symbol of group) this.store!.mergeRest(symbol, bars[symbol] ?? [], watermark, { start, end: completedEnd });
      this.dirty = true;
    };
    // Refresh live candidates first. A sparse symbol's old gap must not force
    // every healthy symbol in its batch to download the entire session again.
    let refreshed = 0;
    for (const group of batch(existing, 50)) {
      await read(group, recentStart);
      refreshed += group.length;
      this.snapshot.diagnostics.bootstrapProgress = `Refreshing today's bars: ${refreshed} / ${existing.length}`;
      this.onChange();
    }
    const repairs = ordered.flatMap(symbol => {
      const gap = firstGap(symbol);
      if (gap === null) { this.backfillAttempts.delete(symbol); return []; }
      if (existingSet.has(symbol) && gap >= recentStart) return []; // Already requested in the recent pass.
      const previous = this.backfillAttempts.get(symbol);
      if (!this.recovering && previous?.gap === gap && now - previous.checkedAt < 300_000) return [];
      return [{ symbol, gap }];
    });
    let repaired = 0;
    for (const group of batch(repairs, 50)) {
      await read(group.map(item => item.symbol), Math.min(...group.map(item => item.gap)));
      for (const { symbol } of group) {
        const gap = firstGap(symbol);
        // Successful REST coverage can still have no-trade minutes. Retry old
        // holes periodically; never manufacture candles or bypass data gates.
        if (gap !== null && gap < recentStart) this.backfillAttempts.set(symbol, { gap, checkedAt: this.now() });
        else this.backfillAttempts.delete(symbol);
      }
      repaired += group.length;
      this.snapshot.diagnostics.bootstrapProgress = `Backfilling today's bars: ${repaired} / ${repairs.length}`;
      this.onChange();
    }
  }

  private selectQuotes(evaluationTime: number): void {
    const session = this.snapshot.session!;
    const promising = this.universe.filter(symbol => this.discoverySymbols.has(symbol)).map(symbol => ({ symbol, value: cheapTrend(this.store!.bars(symbol), session, evaluationTime, this.snapshot.config) }))
      .filter(item => item.value !== null).sort((a, b) => b.value! - a.value! || a.symbol.localeCompare(b.symbol));
    // Fading rows retain quote coverage through the removal grace period. A soft
    // trend/liquidity failure must not become an artificial hard quote failure.
    const incumbents = this.snapshot.rows.map(row => row.evaluation.symbol).filter(symbol => this.discoverySymbols.has(symbol));
    const discovery = [...new Set([...incumbents, ...promising.map(item => item.symbol)])].slice(0, this.snapshot.config.quoteShortlistSize);
    const selected = [...new Set([...discovery, ...[...this.reviewSymbols].filter(symbol => this.universe.includes(symbol))])];
    for (const symbol of this.quotes.keys()) if (!selected.includes(symbol)) this.quotes.delete(symbol);
    for (const symbol of selected) if (!this.quotes.has(symbol)) this.quotes.set(symbol, new QuoteSampler(this.snapshot.config.maxQuoteAgeSeconds));
    this.snapshot.diagnostics.quoteShortlistSize = this.quotes.size;
    this.subscriptions();
  }

  private subscriptions(): void {
    this.stream.setOwnerSubscriptions(OWNER, { bars: this.universe, updatedBars: this.universe, quotes: [...this.quotes.keys()],
      statuses: this.snapshot.config.statusChannelEnabled ? this.universe : [] });
  }

  private profileKey(symbol: string): string { return `profile:${symbol}:${this.snapshot.session!.date}:${this.snapshot.session!.mode ?? 'regular'}:${this.snapshot.config.baselineTargetSessions}:${this.snapshot.config.baselineMinSessions}`; }

  private async loadHistory(session: ScannerSession, signal: AbortSignal, active: () => void): Promise<void> {
    const historical = this.calendar.map(value => sessionSegment(value, session.mode)).filter(value => value.close <= session.open && value.close - value.open === session.close - session.open).slice(-this.snapshot.config.baselineTargetSessions);
    const regular = this.calendar.filter(value => historical.some(segment => segment.date === value.date));
    const missing: string[] = [];
    for (const symbol of this.quotes.keys()) {
      if (this.profiles.get(symbol)?.valid || this.fingerprints[symbol]?.startsWith('unsupported-unit-split:')) continue;
      const cached = this.cache.get<CachedProfile>(this.profileKey(symbol), this.now());
      if (cached && cached.fingerprint === this.fingerprints[symbol] && validCachedProfile(cached.profile, session.date, this.snapshot.config, (session.close - session.open) / MINUTE)) this.profiles.set(symbol, cached.profile);
      else if (!this.historyAttempts.has(symbol) || this.now() - this.historyAttempts.get(symbol)! >= 300_000) missing.push(symbol);
    }
    this.snapshot.diagnostics.historyPending = missing.length;
    for (const group of batch(missing, 5)) {
      if (!historical.length) break;
      for (const symbol of group) this.historyAttempts.set(symbol, this.now());
      this.snapshot.diagnostics.bootstrapProgress = `Loading history: ${group.join(', ')}`;
      this.onChange();
      let raw: Record<string, ScannerBar[]>, regularBars: Record<string, ScannerBar[]>;
      try {
        raw = await this.api.getBars(group, { start: Math.min(historical[0].open, regular[0].open),
          end: Math.max(historical.at(-1)!.close, regular.at(-1)!.close), timeframe: '1Min', ...(session.mode === 'overnight' ? { feed: 'boats' as const } : {}) }, signal); active();
        regularBars = session.mode === 'overnight' ? await this.api.getBars(group, { start: regular[0].open, end: regular.at(-1)!.close, timeframe: '1Min' }, signal) : raw;
        active();
      }
      catch (error) {
        active();
        this.snapshot.diagnostics.warnings.push(`History unavailable for ${group.join(', ')}: ${this.errorText(error)}`);
        this.snapshot.diagnostics.historyPending -= group.length;
        continue;
      }
      for (const symbol of group) {
        const bars = raw[symbol] ?? [];
        const profile = buildVolumeProfile(session, historical.map(value => ({ session: value,
          bars: bars.filter(bar => Date.parse(bar.t) >= value.open && Date.parse(bar.t) < value.close), complete: true,
          regularSession: regular.find(row => row.date === value.date), regularBars: regularBars[symbol] ?? [] })), this.snapshot.config);
        this.profiles.set(symbol, profile);
        this.cache.set(this.profileKey(symbol), { fingerprint: this.fingerprints[symbol], profile }, session.close, this.now());
      }
      // A small bounded raw-history cache supports inspection/replay without storing an unbounded market database.
      this.cache.set('raw-history:last-symbol', { feed: session.mode === 'overnight' ? 'boats' : 'sip', shareBasisDate: session.date, fingerprint: this.fingerprints[group[0]], symbol: group[0], bars: raw[group[0]] ?? [] }, session.close, this.now());
      this.snapshot.diagnostics.historyPending -= group.length;
      this.rank(Math.floor((this.now() - this.snapshot.config.barGraceSeconds * 1000) / MINUTE) * MINUTE);
    }
  }

  private rank(evaluationTime: number): void {
    const session = this.snapshot.session;
    if (!session || !this.store || evaluationTime < session.open || evaluationTime >= session.close || !this.ready || this.recovering || this.subscriptionFailed) return;
    const now = this.now(), previousRows = this.snapshot.rows.map(row => `${row.evaluation.symbol}:${row.state}`);
    this.evaluations = this.universe.map(symbol => {
      const evaluation = evaluateScanner({ symbol, bars: this.store!.bars(symbol), session, evaluationTime,
        barsCoveredThrough: this.store!.coveredThrough(symbol),
        profile: this.profiles.get(symbol) ?? null, quote: this.quotes.get(symbol)?.metrics(now) ?? null,
        eligible: this.assets.has(symbol) && !this.fingerprints[symbol]?.startsWith('unsupported-unit-split:'), halted: this.tradingStatuses.get(symbol)?.halted,
        priorClose: this.previousClose[symbol], config: this.snapshot.config });
      if (evaluation.dataStatus === 'loading-history' && !this.profiles.has(symbol) && !this.quotes.has(symbol) && !this.historyAttempts.has(symbol)) {
        evaluation.reasons = ['Historical volume profile not requested; outside the quote shortlist'];
      }
      return evaluation;
    });
    this.state = updateScannerState(this.state, this.evaluations.filter(value => this.discoverySymbols.has(value.symbol)), this.snapshot.config);
    for (const symbol of Object.keys(this.state.entries)) {
      if (!this.universe.includes(symbol) && !this.state.recentRows.some(row => row.symbol === symbol)) delete this.state.entries[symbol];
    }
    this.refreshRows();
    const counts: Record<string, number> = {};
    for (const evaluation of this.evaluations) for (const reason of evaluation.reasons) counts[reason] = (counts[reason] ?? 0) + 1;
    const latestBarLag = (symbols: string[]): number | null => {
      const bars = symbols.map(symbol => this.store!.bars(symbol).filter(bar => Date.parse(bar.t) + MINUTE <= evaluationTime).at(-1)).filter((bar): bar is ScannerBar => !!bar);
      return bars.length ? Math.max(...bars.map(bar => Math.max(0, (now - Date.parse(bar.t) - MINUTE) / 1000))) : null;
    };
    const ages = [...this.quotes.values()].map(sampler => sampler.metrics(now).quoteAgeSeconds).filter((age): age is number => age !== null);
    this.snapshot.diagnostics = { ...this.snapshot.diagnostics, historyReady: [...this.profiles.values()].filter(profile => profile.valid).length,
      cacheHits: this.cache.hits, qualifyingCount: this.evaluations.filter(value => value.qualified).length,
      lastRanking: evaluationTime, exclusionCounts: counts,
      barsReady: this.evaluations.filter(value => value.features.sessionVWAP !== null && value.features.priceTimestamp === new Date(evaluationTime).toISOString()).length,
      historyUnrequested: this.universe.filter(symbol => !this.profiles.has(symbol) && !this.quotes.has(symbol) && !this.historyAttempts.has(symbol)).length,
      barLagSeconds: latestBarLag([...this.quotes.keys()]), worstUniverseBarLagSeconds: latestBarLag(this.universe),
      quoteAgeSeconds: ages.length ? Math.max(...ages) : null };
    const changes = this.snapshot.rows.map(row => `${row.evaluation.symbol}:${row.state}`).filter(row => !previousRows.includes(row));
    changes.push(...previousRows.filter(row => !this.snapshot.rows.some(value => `${value.evaluation.symbol}:${value.state}` === row)).map(row => `removed:${row}`));
    this.record(evaluationTime, changes);
    this.watermark = evaluationTime; this.dirty = false;
    const forming = evaluationTime - session.open < 30 * MINUTE;
    const loading = this.quotes.size > 0 && [...this.quotes.keys()].some(symbol => !this.profiles.has(symbol));
    const noCurrentBars = evaluationTime > session.open && this.evaluations.length > 0 && this.evaluations.every(value => value.reasons.includes('Missing, stale, or invalid session minute bars'));
    const noRecentTrades = this.evaluations.length > 0 && this.evaluations.every(value => value.reasons.includes('No trade bar for the latest completed minute'));
    this.publish(noCurrentBars ? 'error' : forming ? 'forming' : loading ? 'loading' : 'live', noCurrentBars ? 'Current session bars are unavailable. Results are not live; awaiting gap recovery.'
      : forming ? 'Forming — 30 completed session minutes are required.' : loading ? 'Loading history — candidates appear as their data becomes usable.' : noRecentTrades ? 'Waiting for fresh trade bars; no candidates currently qualify.' : '24/5 session live');
  }

  private refreshRows(): void {
    this.snapshot.rows = this.state.visible.map(symbol => this.state.entries[symbol]).filter(entry => !!entry)
      .map(entry => ({ evaluation: entry.evaluation, state: entry.state === 'fading' ? 'Fading' : 'Clean uptrend', confirmed: entry.admitted && entry.evaluation.qualified, bars: this.store?.bars(entry.evaluation.symbol) ?? [] }));
    this.snapshot.recentRows = this.state.recentRows.filter(entry => this.now() - entry.lastQualifiedAt < 15 * MINUTE)
      .map(entry => ({ evaluation: entry.evaluation, state: 'Fading', lastQualifiedAt: entry.lastQualifiedAt, bars: this.store?.bars(entry.symbol) ?? [] }));
    const shown = [...this.state.visible, ...this.state.recentRows.map(entry => entry.symbol)];
    this.snapshot.candidates = (this.ready && !this.recovering && !this.subscriptionFailed ? selectScannerCandidates(this.evaluations.filter(value => this.discoverySymbols.has(value.symbol)), shown, this.snapshot.config) : [])
      .map(evaluation => ({ evaluation, state: scannerRowStatus(evaluation, 'Candidate'), bars: this.store?.bars(evaluation.symbol) ?? [] }));
    this.snapshot.reviewRows = this.evaluations.map(evaluation => ({ evaluation, state: scannerRowStatus(evaluation,
      this.state.entries[evaluation.symbol]?.state === 'fading' ? 'Fading' : this.state.entries[evaluation.symbol]?.admitted && evaluation.qualified ? 'Clean uptrend' : evaluation.qualified ? 'Candidate' : 'Not qualified'),
      confirmed: !!this.state.entries[evaluation.symbol]?.admitted && evaluation.qualified && !evaluation.hardFailure,
      bars: this.store?.bars(evaluation.symbol) ?? [] }));
  }

  private invalidateBadQuotes(now: number): void {
    let changed = false;
    const monitoring = (this.snapshot.reviewRows ?? []).filter(row => (this.reviewSymbols.has(row.evaluation.symbol) || this.state.entries[row.evaluation.symbol]?.admitted) && !row.evaluation.hardFailure);
    const checked = new Map([...this.snapshot.rows, ...monitoring].map(row => [row.evaluation.symbol, row]));
    for (const row of checked.values()) {
      const metrics = this.quotes.get(row.evaluation.symbol)?.metrics(now);
      if (!metrics?.valid || metrics.currentSpreadBps === null) {
        this.hardInvalidate(row.evaluation.symbol, metrics?.reasons.join('; ') || 'Quote unavailable.'); changed = true;
      } else if (metrics.currentSpreadBps > this.snapshot.config.maxCurrentSpreadBps || metrics.medianSpreadBps! > this.snapshot.config.maxMedianSpreadBps) {
        const evaluation = evaluateScanner({ symbol: row.evaluation.symbol, session: this.snapshot.session!, bars: row.bars,
          barsCoveredThrough: this.store?.coveredThrough(row.evaluation.symbol),
          evaluationTime: this.watermark, quote: metrics, profile: this.profiles.get(row.evaluation.symbol) ?? null,
          eligible: this.assets.has(row.evaluation.symbol), halted: this.tradingStatuses.get(row.evaluation.symbol)?.halted,
          priorClose: this.previousClose[row.evaluation.symbol], config: this.snapshot.config });
        this.evaluations = this.evaluations.map(value => value.symbol === evaluation.symbol ? evaluation : value);
        if (this.discoverySymbols.has(evaluation.symbol)) this.state = updateScannerState(this.state, [evaluation], this.snapshot.config);
        this.refreshRows();
        this.snapshot.diagnostics.qualifyingCount = this.evaluations.filter(value => value.qualified).length;
        if (row.state !== 'Fading') this.record(this.watermark, [`${evaluation.symbol}:Fading — spread exceeded threshold`]);
        changed = row.state !== 'Fading' || changed;
      }
    }
    if (changed) this.onChange();
  }
  private hardInvalidate(symbol: string, reason: string): void {
    const evaluation = this.evaluations.find(value => value.symbol === symbol);
    if (!evaluation) return;
    const invalid = { ...evaluation, qualified: false, hardFailure: true, dataStatus: 'unavailable' as const, reasons: [reason], flags: ['Data unavailable'] };
    this.evaluations = this.evaluations.map(value => value.symbol === symbol ? invalid : value);
    if (this.discoverySymbols.has(symbol)) this.state = updateScannerState(this.state, [invalid], this.snapshot.config);
    this.refreshRows();
    this.snapshot.diagnostics.qualifyingCount = this.evaluations.filter(value => value.qualified).length;
    this.record(this.watermark, [`${symbol}:Data unavailable — ${reason}`]);
  }
  private invalidateAll(): void {
    const symbols = this.snapshot.rows.map(row => row.evaluation.symbol);
    this.evaluations = this.evaluations.map(value => ({ ...value, qualified: false, hardFailure: true, dataStatus: 'unavailable', flags: ['Data unavailable'], reasons: ['Scanner connection or configuration unavailable'] }));
    if (symbols.length) this.record(this.watermark, symbols.map(symbol => `${symbol}:Data unavailable`));
    this.state = createScannerState(); this.refreshRows(); this.snapshot.rows = []; this.snapshot.candidates = []; this.snapshot.recentRows = []; this.snapshot.diagnostics.qualifyingCount = 0; this.watermark = 0;
  }
  private record(evaluationTime: number, changes: string[]): void {
    if (!this.snapshot.config.snapshotLimit) return;
    const record = { evaluationTime, recordedAt: this.now(), configVersion: this.snapshot.config.version,
      entries: this.evaluations.filter(value => this.quotes.has(value.symbol) || changes.some(change => change.startsWith(`${value.symbol}:`) || change.startsWith(`removed:${value.symbol}:`))), changes };
    const index = this.records.findIndex(value => value.evaluationTime === evaluationTime && value.configVersion === record.configVersion);
    if (index >= 0) { record.changes = [...new Set([...this.records[index].changes, ...changes])].slice(-150); this.records[index] = record; }
    else this.records.push(record);
    while (this.records.length > this.snapshot.config.snapshotLimit || (this.records.length > 1 && JSON.stringify(this.records).length > 1_000_000)) this.records.shift();
    this.cache.set('selection-snapshots', this.records, this.now() + 7 * DAY, this.now());
  }
  private publish(status: ScannerSnapshot['status'], message: string): void {
    this.snapshot.status = status; this.snapshot.message = message;
    if (this.cache.warning && !this.snapshot.diagnostics.warnings.includes(this.cache.warning)) this.snapshot.diagnostics.warnings.push(this.cache.warning);
    this.onChange();
  }
  private errorText(error: unknown): string { return error instanceof Error ? error.message : 'Scanner data unavailable.'; }
}

function scannerRowStatus(evaluation: ScannerEvaluation, ready: ScannerRow['state']): ScannerRow['state'] {
  return ({ ready, unavailable: 'Data unavailable', 'loading-history': 'Loading history', 'warming-quotes': 'Warming quotes', forming: 'Forming', closed: 'Not live' } as const)[evaluation.dataStatus];
}

/** Observed trend candidates remain separate from admission and never count as live picks. */
export function selectScannerCandidates(evaluations: ScannerEvaluation[], excluded: string[], config: ScannerConfig): ScannerEvaluation[] {
  const hidden = new Set(excluded);
  return evaluations.filter(evaluation => {
    if (hidden.has(evaluation.symbol) || ['closed', 'forming'].includes(evaluation.dataStatus)) return false;
    const f = evaluation.features;
    // These features require valid bars and verified coverage of session omissions.
    // RVOL and quotes may still be pending; unknown values remain visibly unknown.
    return f.price !== null && f.price >= config.minPrice && f.priceTimestamp !== null && Date.parse(f.priceTimestamp) === evaluation.evaluationTime &&
      f.dollarVolume5m !== null && f.dollarVolume5m >= config.minDollarVolume5m &&
      (f.averageDailyRthDollarVolume === null || f.averageDailyRthDollarVolume >= config.minAverageDailyRthDollarVolume) &&
      f.return30 !== null && f.return30 >= config.minReturn30 && f.slope30 !== null && f.slope30 > 0 &&
      f.slope10 !== null && f.slope10 > 0 && f.return10 !== null && f.return10 > 0 &&
      f.efficiency30 !== null && f.efficiency30 >= config.minEfficiency30 && f.r2_30 !== null && f.r2_30 >= config.minR2_30 &&
      f.sessionVWAP !== null && f.price > f.sessionVWAP && f.vwapHold30 !== null && f.vwapHold30 >= config.minVwapHold30 &&
      f.jumpShare !== null && f.jumpShare <= config.maxJumpShare &&
      !evaluation.reasons.some(reason => /halt|not eligible|corporate action|unit split|no longer in|connection or configuration unavailable/i.test(reason));
  }).sort((a, b) => Number(b.qualified) - Number(a.qualified) || Number(b.dataStatus === 'ready') - Number(a.dataStatus === 'ready') ||
    (b.score ?? -1) - (a.score ?? -1) || b.features.efficiency30! * b.features.r2_30! - a.features.efficiency30! * a.features.r2_30! ||
    a.symbol.localeCompare(b.symbol)).slice(0, config.maxResults);
}

/** Cheap completed-bar screen runs for every base-universe symbol, including non-movers. */
export function cheapTrend(bars: ScannerBar[], session: ScannerSession, evaluationTime: number, config: ScannerConfig): number | null {
  const end = Math.min(session.close, evaluationTime), start = end - 30 * MINUTE;
  if (start < session.open) return null;
  const recent = completedSessionBars(bars, session, end).filter(bar => Date.parse(bar.t) >= start);
  const trend = calculateWindow(recent, 30, end, !!session.mode);
  if (!trend) return null;
  const price = recent.at(-1)!.c, initial = recent[0].o, path = [initial, ...recent.map(bar => bar.c)];
  const move = price / initial - 1, variation = path.slice(1).reduce((sum, value, i) => sum + Math.abs(value - path[i]), 0);
  const last = recent.filter(bar => Date.parse(bar.t) >= end - 5 * MINUTE);
  if (last.some(bar => !Number.isFinite(bar.vw) || bar.vw! <= 0 || !Number.isFinite(bar.v) || bar.v < 0)) return null;
  const dollars = last.reduce((sum, bar) => sum + bar.v * bar.vw!, 0);
  if (price < config.minPrice || move < config.minReturn30 || dollars < config.minDollarVolume5m || variation <= 0) return null;
  return move * Math.abs(price - initial) / variation * Math.log1p(dollars);
}

function validCachedProfile(profile: VolumeProfile, date: string, config: ScannerConfig, minutes = 390): boolean {
  const shapeValid = !!profile && profile.valid && profile.sampleCount >= config.baselineMinSessions && profile.sampleCount <= config.baselineTargetSessions &&
    Array.isArray(profile.sessionDates) && profile.sessionDates.length === profile.sampleCount && new Set(profile.sessionDates).size === profile.sampleCount && profile.sessionDates.every(value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && value < date) &&
    Array.isArray(profile.meanMinuteVolume) && profile.meanMinuteVolume.length === minutes && profile.meanMinuteVolume.every(value => Number.isFinite(value) && value >= 0) &&
    Array.isArray(profile.meanCumulativeVolume) && profile.meanCumulativeVolume.length === minutes && profile.meanCumulativeVolume.every(value => Number.isFinite(value) && value >= 0) &&
    Number.isFinite(profile.averageDailyRthDollarVolume) && profile.averageDailyRthDollarVolume! > 0;
  if (!shapeValid) return false;
  let cumulative = 0;
  return profile.meanMinuteVolume.every((value, index) => {
    cumulative += value;
    return Math.abs(profile.meanCumulativeVolume[index] - cumulative) <= Math.max(1e-6, cumulative * 1e-10);
  });
}
