import { tradingDate } from '../../core/exchange-session';
import { yieldTask as yieldToBrowser } from '../../core/task';
import { isOvernightTime } from '../../core/trading-session';
import type { DataReads } from '../../broker/reads';
import { canonicalSerialize } from './values';
import type { AccountScope } from '../../core/account';
import { validSession } from '../templates/common';
import { trendFollowing } from '../templates/trend-following';
import { identifier, instant, requireValue } from '../../core/validation';
import { sameScope } from '../validation';
import { researchTrend, TREND_RESEARCH_POLICY, trendRejection, type TrendEvaluation } from './trend';
import { UNIVERSE_LIMITS, validateUniverseContext, type UniverseContext, type UniverseSnapshot } from './universe';

type HistoryApi = Pick<DataReads, 'getBars'>;
const limits = TREND_RESEARCH_POLICY.limits;
const abortError = () => new DOMException('Research cancelled', 'AbortError');
export interface ResearchProgress {
  readonly status: 'idle' | 'running' | 'complete' | 'blocked' | 'failed' | 'cancelled';
  readonly generation: number;
  readonly snapshotRef: string | null;
  readonly completedSymbols: number;
  readonly historyRequests: number;
  readonly testedCandidates: number;
  readonly reasonCode: string | null;
}
export interface TrendResearchBatch {
  readonly schemaVersion: 1;
  readonly scope: AccountScope;
  readonly connectionGeneration: number;
  readonly snapshotRef: string;
  readonly generatedAt: string;
  readonly dataCutoff: string;
  readonly policy: typeof TREND_RESEARCH_POLICY;
  readonly universeBreadth: UniverseSnapshot['breadth'];
  readonly history: { readonly source: 'alpaca:/v2/stocks/bars'; readonly feed: 'sip'; readonly adjustment: 'split';
    readonly timeframe: '5Min'; readonly start: string; readonly end: string };
  readonly evaluations: readonly TrendEvaluation[];
  readonly counts: { readonly inputSymbols: number; readonly researchedSymbols: number; readonly selectedSymbols: number;
    readonly testedCandidates: number; readonly historyRequests: number };
}
export type ScheduledResearch =
  | { readonly status: 'complete'; readonly batch: TrendResearchBatch }
  | { readonly status: 'blocked' | 'failed' | 'cancelled'; readonly reasonCode: string; readonly reason: string };

/** One bounded job, no queue or automatic retry. Call on a new input snapshot, never render.
 * Production uses macrotask yields, including before preparation and EVERY simulation.
 * Connection orchestration supplies the matching read-only adapter and calls setContext.
 */
export class TrendResearchScheduler {
  private executionWork = 0;
  private context: UniverseContext | null = null;
  private generation = 0;
  private lastStarted = -Infinity;
  private latestCutoff = -Infinity;
  private job: { key: string; controller: AbortController; promise: Promise<ScheduledResearch> } | null = null;
  private progress: ResearchProgress = { status: 'idle', generation: 0, snapshotRef: null, completedSymbols: 0,
    historyRequests: 0, testedCandidates: 0, reasonCode: null };

  constructor(private api: HistoryApi, private readonly now: () => number) {}
  getProgress(): ResearchProgress { return structuredClone(this.progress); }

  setContext(context: UniverseContext | null, api: HistoryApi = this.api): void {
    try { if (context) validateUniverseContext(context); }
    catch (error) { this.setContext(null); throw error; }
    if (api === this.api && canonicalSerialize(context) === canonicalSerialize(this.context)) return;
    this.cancel(); this.context = context ? structuredClone(context) : null; this.api = api;
    this.generation++; this.latestCutoff = -Infinity;
    this.progress = { status: 'idle', generation: this.generation, snapshotRef: null, completedSymbols: 0,
      historyRequests: 0, testedCandidates: 0, reasonCode: null };
  }
  cancel(): void {
    this.job?.controller.abort(); this.job = null;
    if (this.progress.status === 'running') this.progress = { ...this.progress, status: 'cancelled', reasonCode: 'generation_cancelled' };
  }
  dispose(): void { this.setContext(null); }
  /** Runtime owns this priority token through reconciliation and exit submission. */
  prioritizeExecution(): () => void {
    this.executionWork++; this.cancel();
    let released = false;
    return () => { if (!released) { released = true; this.executionWork--; } };
  }

  /** Equal completed-bar bucket, listing order, eligibility and session bounds share one result.
   * Snapshot IDs, render time and changing quote prices alone do not rerun a parameter search.
   */
  schedule(value: UniverseSnapshot): Promise<ScheduledResearch> {
    let snapshot: UniverseSnapshot;
    const reject = (reasonCode: string, reason: string): Promise<ScheduledResearch> => {
      this.cancel();
      this.progress = { ...this.progress, status: 'blocked', reasonCode };
      return Promise.resolve(structuredClone({ status: 'blocked', reasonCode, reason }));
    };
    if (this.executionWork) return reject('execution_priority', 'Execution reconciliation has priority over research');
    try {
      this.validateSnapshot(value);
      snapshot = structuredClone(value);
    } catch { return reject('invalid_snapshot', 'A bounded, current, matching universe/session snapshot is required'); }
    const started = this.now(), context = this.context!;
    if (!this.current(snapshot, context, started)) return reject('context_unavailable', 'Paper scope, current session and fresh SIP inputs are required');
    const cutoff = Date.parse(snapshot.dataCutoff);
    if (cutoff < this.latestCutoff) return reject('obsolete_snapshot', 'A newer data cutoff has already been observed');
    this.latestCutoff = cutoff;
    const eligibility = snapshot.candidates.map(candidate => trendFollowing.discoveryEligibility({ session: snapshot.session,
      dataCutoff: snapshot.dataCutoff, capabilities: snapshot.data.capabilities, quote: candidate.quote }));
    const key = canonicalSerialize({ scope: snapshot.scope, connectionGeneration: snapshot.connectionGeneration,
      session: [snapshot.session.calendarId, snapshot.session.tradingDate, snapshot.session.openAt, snapshot.session.closeAt],
      historySessions: snapshot.previousSessions.map(session => [session.tradingDate, session.openAt, session.closeAt]),
      bucket: Math.floor(cutoff / 300_000), candidates: snapshot.candidates.map((candidate, index) =>
        [candidate.asset.id, candidate.asset.symbol, eligibility[index].map(block => block.code)]) });
    if (this.job?.key === key && !this.job.controller.signal.aborted) return this.job.promise;
    this.cancel();
    if (started < this.lastStarted + limits.refreshMs) return reject('refresh_limited', 'Trend research is limited to one start per five minutes');
    this.lastStarted = started;
    const controller = new AbortController(), generation = this.generation, api = this.api;
    this.progress = { status: 'running', generation, snapshotRef: snapshot.id, completedSymbols: 0,
      historyRequests: 0, testedCandidates: 0, reasonCode: null };
    // Microtask deferral installs the identity fence before any asynchronous job can report progress.
    const promise = Promise.resolve().then(() => this.run(snapshot, context, api, eligibility, started, generation, controller));
    this.job = { key, controller, promise };
    return promise;
  }

  private validateSnapshot(snapshot: UniverseSnapshot): void {
    requireValue(!!this.context, 'context', 'missing');
    requireValue(snapshot.schemaVersion === 1, 'snapshot', 'schema'); identifier(snapshot.id, 'snapshot.id');
    instant(snapshot.requestedAt, 'requestedAt'); instant(snapshot.asOf, 'asOf'); instant(snapshot.dataCutoff, 'cutoff');
    requireValue(snapshot.requestedAt <= snapshot.asOf && snapshot.asOf === snapshot.dataCutoff, 'snapshot', 'times');
    validateUniverseContext({ scope: snapshot.scope, connectionGeneration: snapshot.connectionGeneration,
      tradingDate: snapshot.session.tradingDate, data: snapshot.data });
    requireValue(validSession(snapshot.session) && snapshot.session.calendarAsOf <= snapshot.dataCutoff, 'session', 'invalid');
    requireValue(Array.isArray(snapshot.previousSessions) && snapshot.previousSessions.length <= UNIVERSE_LIMITS.previousSessions
      && snapshot.previousSessions.every(session => validSession(session) && session.calendarAsOf <= snapshot.dataCutoff
        && session.closeAt < snapshot.session.openAt)
      && new Set(snapshot.previousSessions.map(session => session.tradingDate)).size === snapshot.previousSessions.length, 'history', 'sessions');
    requireValue(Array.isArray(snapshot.candidates) && snapshot.candidates.length <= UNIVERSE_LIMITS.candidates
      && new Set(snapshot.candidates.map(candidate => candidate.asset.symbol)).size === snapshot.candidates.length, 'candidates', 'size_or_duplicates');
    snapshot.candidates.forEach(candidate => {
      identifier(candidate.asset.id, 'listing');
      requireValue(/^[A-Z][A-Z0-9.-]{0,14}$/.test(candidate.asset.symbol) && candidate.asset.exchange !== 'OTC', 'symbol', 'invalid');
    });
    requireValue(Array.isArray(snapshot.liquidity) && snapshot.liquidity.length <= UNIVERSE_LIMITS.assets, 'liquidity', 'size');
  }

  private current(snapshot: UniverseSnapshot, context: UniverseContext, now: number): boolean {
    const validData = (data: UniverseContext['data']) => data.status === 'available' && data.feed === (isOvernightTime(now) ? 'boats' : 'sip')
      && data.capabilities.includes('completed_5min_bars') && data.capabilities.includes('observed_prices')
      && Date.parse(data.asOf) <= now && now < Date.parse(data.validUntil) && now - Date.parse(data.asOf) <= UNIVERSE_LIMITS.contextMaxAgeMs;
    return Number.isFinite(now) && Number.isFinite(new Date(now).getTime()) && sameScope(context.scope, snapshot.scope)
      && ['paper', 'live'].includes(context.scope.environment) && context.scope.broker === 'alpaca'
      && context.connectionGeneration === snapshot.connectionGeneration && context.tradingDate === snapshot.session.tradingDate
      && tradingDate(now) === context.tradingDate && now >= Date.parse(snapshot.session.openAt)
      && now < Date.parse(snapshot.session.closeAt) - 15 * 60_000 && Date.parse(snapshot.dataCutoff) <= now
      && now - Date.parse(snapshot.dataCutoff) <= limits.snapshotMaxAgeMs && validData(context.data) && validData(snapshot.data);
  }

  private async run(snapshot: UniverseSnapshot, context: UniverseContext, api: HistoryApi,
    eligibility: readonly (readonly { code: string; reason: string }[])[], started: number, generation: number, controller: AbortController): Promise<ScheduledResearch> {
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, limits.durationMs);
    const owns = () => this.job?.controller === controller && this.generation === generation;
    const active = () => {
      if (controller.signal.aborted || !owns()) throw abortError();
      const time = this.now();
      if (time - started >= limits.durationMs) { timedOut = true; controller.abort(); throw abortError(); }
      if (time < started || !this.current(snapshot, context, time)) { controller.abort(); throw abortError(); }
    };
    const wait = async <T>(action: () => Promise<T>): Promise<T> => {
      active();
      let abort!: () => void;
      const cancelled = new Promise<never>((_resolve, reject) => {
        abort = () => reject(abortError()); controller.signal.addEventListener('abort', abort, { once: true });
      });
      try { const result = await Promise.race([action(), cancelled]); active(); return result; }
      finally { controller.signal.removeEventListener('abort', abort); }
    };
    const yieldTask = () => wait(yieldToBrowser);
    const evaluations: TrendEvaluation[] = [];
    const start = Date.parse(snapshot.dataCutoff) - limits.historyDays * 86_400_000;
    const end = Math.floor(Date.parse(snapshot.dataCutoff) / 300_000) * 300_000;
    let next = 0, scheduled = 0;
    const selected: { index: number; symbol: string }[] = [];
    snapshot.candidates.forEach((candidate, index) => {
      const symbol = candidate.asset.symbol;
      if (eligibility[index].length) evaluations[index] = trendRejection(symbol, 'rejected', eligibility[index][0].code, eligibility[index][0].reason);
      else if (scheduled++ >= limits.symbols) evaluations[index] = trendRejection(symbol, 'omitted', 'symbol_budget', 'Outside the first four eligible neutral candidates');
      else selected.push({ index, symbol });
    });
    try {
      await Promise.all(Array.from({ length: Math.min(limits.concurrency, selected.length) }, async () => {
        while (next < selected.length) {
          active();
          const { index, symbol } = selected[next++];
          try {
            this.progress = { ...this.progress, historyRequests: this.progress.historyRequests + 1 };
            const response = await wait(() => api.getBars([symbol], { start, end, timeframe: '5Min',
              maxPagesPerBatch: limits.historyPagesPerSymbol, maxBarsPerSymbol: limits.barsPerSymbol }, controller.signal));
            requireValue(Object.keys(response).length === 1 && Array.isArray(response[symbol])
              && response[symbol].length <= limits.barsPerSymbol, 'history', 'invalid_response');
            const bars = structuredClone(response[symbol]);
            requireValue(bars.every(bar => [bar.o, bar.h, bar.l, bar.c, bar.v].every(Number.isFinite)
              && Math.min(bar.o, bar.h, bar.l, bar.c) > 0 && bar.v >= 0
              && bar.h >= Math.max(bar.o, bar.c, bar.l) && bar.l <= Math.min(bar.o, bar.c, bar.h)), 'history', 'invalid_candle');
            requireValue(bars.every(bar => Date.parse(bar.t) >= start && Date.parse(bar.t) + 300_000 <= end), 'history', 'outside_cutoff');
            await yieldTask();
            const search = researchTrend({ scope: snapshot.scope, snapshotRef: snapshot.id, symbol, session: snapshot.session,
              sessions: [...snapshot.previousSessions.filter(session => Date.parse(session.closeAt) > start), snapshot.session],
              dataCutoff: snapshot.dataCutoff, bars });
            let step = search.next();
            while (!step.done) {
              await yieldTask();
              const training = step.value.phase === 'training';
              step = search.next();
              if (training) this.progress = { ...this.progress, testedCandidates: this.progress.testedCandidates + 1 };
            }
            evaluations[index] = step.value;
          } catch {
            active(); // Cancellation/expiry aborts the batch rather than publishing partial candidates.
            evaluations[index] = trendRejection(symbol, 'unavailable', 'history_or_search_unavailable', 'Bounded history or parameter research could not be loaded or validated');
          }
          this.progress = { ...this.progress, completedSymbols: this.progress.completedSymbols + 1 };
        }
      }));
      active();
      const batch: TrendResearchBatch = { schemaVersion: 1, scope: snapshot.scope, connectionGeneration: snapshot.connectionGeneration,
        snapshotRef: snapshot.id, generatedAt: new Date(this.now()).toISOString(), dataCutoff: snapshot.dataCutoff,
        policy: TREND_RESEARCH_POLICY, universeBreadth: snapshot.breadth,
        history: { source: 'alpaca:/v2/stocks/bars', feed: 'sip', adjustment: 'split', timeframe: '5Min',
          start: new Date(start).toISOString(), end: new Date(end).toISOString() }, evaluations,
        counts: { inputSymbols: snapshot.candidates.length, researchedSymbols: selected.length,
          selectedSymbols: evaluations.filter(value => value.status === 'selected').length,
          testedCandidates: this.progress.testedCandidates, historyRequests: this.progress.historyRequests } };
      this.progress = { ...this.progress, status: 'complete' };
      return structuredClone({ status: 'complete', batch });
    } catch {
      const result: ScheduledResearch = timedOut
        ? { status: 'failed', reasonCode: 'research_timeout', reason: 'The fixed research deadline elapsed' }
        : { status: 'cancelled', reasonCode: 'generation_cancelled', reason: 'Research was cancelled or its account/session/data context became obsolete' };
      if (owns()) this.progress = { ...this.progress, status: result.status, reasonCode: result.reasonCode };
      return structuredClone(result);
    } finally { clearTimeout(timer); }
  }
}
