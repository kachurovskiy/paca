import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tuneMomentum } from '../math/momentum';
import type { ScannerBar } from '../../scanner/types';
import { TREND_RESEARCH_POLICY } from './trend';
import { trendFixture } from './trend-fixtures';
import { TrendResearchScheduler, type ScheduledResearch } from './scheduler';
import type { UniverseContext, UniverseSnapshot } from './universe';

const services: TrendResearchScheduler[] = [];
beforeEach(() => {
  for (const name of ['fetch', 'XMLHttpRequest', 'WebSocket']) vi.stubGlobal(name, vi.fn(() => { throw new Error('Research cannot use network globals'); }));
});
afterEach(() => { services.splice(0).forEach(service => service.dispose()); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const flush = async () => { for (let index = 0; index < 20; index++) await Promise.resolve(); };
async function setup(count = 3) {
  const fixture = trendFixture(count), snapshot = await fixture.capture();
  let time = fixture.now;
  const api = { getBars: vi.fn(fixture.api.getBars) };
  const scheduler = new TrendResearchScheduler(api, () => time); services.push(scheduler); scheduler.setContext(fixture.context);
  return { ...fixture, api, snapshot, scheduler, setNow: (value: number) => { time = value; } };
}
function batch(result: ScheduledResearch) {
  expect(result.status).toBe('complete');
  if (result.status !== 'complete') throw new Error(result.reasonCode);
  return result.batch;
}
function refreshed(snapshot: UniverseSnapshot, time: number): UniverseSnapshot {
  const asOf = new Date(time).toISOString();
  return { ...snapshot, id: 'refreshed', requestedAt: asOf, asOf, dataCutoff: asOf,
    data: { ...snapshot.data, asOf, validUntil: new Date(time + 60_000).toISOString() },
    candidates: snapshot.candidates.map(candidate => ({ ...candidate, quote: candidate.quote && { ...candidate.quote, tradeAt: asOf, quoteAt: asOf } })) };
}

describe('bounded experimental Trend discovery', () => {
  it('researches matching live contexts and preserves live candidate scope', async () => {
    const s = await setup(3), scope = { ...s.context.scope, environment: 'live' as const };
    s.scheduler.setContext({ ...s.context, scope });
    const result = batch(await s.scheduler.schedule({ ...s.snapshot, scope }));
    expect(result.scope).toEqual(scope);
    expect(result.evaluations.filter(row => row.candidate).length).toBeGreaterThan(0);
    expect(result.evaluations.filter(row => row.candidate).every(row => row.candidate!.scope.environment === 'live')).toBe(true);
  });
  it('cancels obsolete research and blocks scheduling until every execution priority token is released', async () => {
    const s = await setup(), first = s.scheduler.prioritizeExecution(), second = s.scheduler.prioritizeExecution();
    expect(await s.scheduler.schedule(s.snapshot)).toMatchObject({ status: 'blocked', reasonCode: 'execution_priority' });
    first(); first(); expect(await s.scheduler.schedule(s.snapshot)).toMatchObject({ reasonCode: 'execution_priority' });
    second(); expect((await s.scheduler.schedule(s.snapshot)).status).toBe('complete');
  });
  it('selects deterministic settings with inspectable rejected symbols and unchanged legacy selection', async () => {
    const s = await setup();
    const result = batch(await s.scheduler.schedule(s.snapshot));
    expect(result.counts).toMatchObject({ inputSymbols: 3, researchedSymbols: 3, selectedSymbols: 2, historyRequests: 3 });
    expect(result.evaluations.map(value => [value.symbol, value.status])).toEqual([['S0002', 'selected'], ['S0001', 'selected'], ['S0000', 'rejected']]);
    for (const evaluation of result.evaluations) {
      const report = tuneMomentum(evaluation.symbol, s.history(evaluation.symbol, s.api.getBars.mock.calls[0][1]), s.now);
      expect(evaluation.search!.report).toEqual(report);
      expect(evaluation.search!.tested.length).toBeLessThanOrEqual(66);
      expect(evaluation.search!.trainingSessions).toEqual(['2026-09-14', '2026-09-15', '2026-09-16']);
      expect(evaluation.search!.validationSessions).toEqual(['2026-09-17', '2026-09-18']);
      if (evaluation.candidate) {
        expect(evaluation.candidate.parameters).toEqual(report.setups.find(setup => setup.eligible)!.parameters);
        expect(evaluation.candidate.parameters).toMatchObject({ fastPeriod: 4, slowPeriod: 16 });
        expect(evaluation.candidate.evidence).toMatchObject({ status: 'experimental', snapshotRef: s.snapshot.id, testedCandidateCount: evaluation.search!.tested.length });
        expect(evaluation.candidate.forecast).toMatchObject({ status: 'unavailable', meanPnlCents: null, medianPnlCents: null, quantiles: null, probabilityOfProfit: null });
        expect(evaluation.candidate.forecast.reason).toContain('no calibrated EOD estimator');
        expect(evaluation.candidate.evidence.assumptions.fees).toContain('actual fees unavailable');
        expect(evaluation.candidate.evidence.limitations.join(' ')).toContain('pipeline is not validated');
        expect(evaluation.candidate.intendedEnd).toBe('2026-09-21T23:55:00.000Z');
        expect(evaluation.candidate.entryWindow.to).toBe('2026-09-21T23:45:00.000Z');
        expect(evaluation.candidate).not.toHaveProperty('capital');
      }
    }
    expect(result.counts.testedCandidates).toBe(result.evaluations.reduce((sum, value) => sum + value.search!.tested.length, 0));
    
    expect(s.scheduler.getProgress()).toMatchObject({ status: 'complete', completedSymbols: 3 });
    expect(fetch).not.toHaveBeenCalled(); expect(XMLHttpRequest).not.toHaveBeenCalled(); expect(WebSocket).not.toHaveBeenCalled();
  });

  it('caps symbols, concurrent reads, parameter searches, history range and pages', async () => {
    const s = await setup(9);
    let active = 0, maximum = 0;
    s.api.getBars.mockImplementation(async (...args) => {
      maximum = Math.max(maximum, ++active); await new Promise(resolve => setTimeout(resolve, 1));
      active--; return Object.fromEntries(args[0].map(symbol => [symbol, s.history(symbol, args[1])]));
    });
    const result = batch(await s.scheduler.schedule(s.snapshot));
    expect(maximum).toBe(2); expect(s.api.getBars).toHaveBeenCalledTimes(4);
    expect(result.counts.testedCandidates).toBeLessThanOrEqual(4 * 66);
    expect(result.evaluations.filter(value => value.reasonCode === 'symbol_budget')).toHaveLength(5);
    for (const [symbols, options, signal] of s.api.getBars.mock.calls) {
      expect(symbols).toHaveLength(1); expect(signal).toBeInstanceOf(AbortSignal);
      expect(options).toEqual({ start: s.now - 7 * 86_400_000, end: Math.floor(s.now / 300_000) * 300_000,
        timeframe: '5Min', maxPagesPerBatch: 2, maxBarsPerSymbol: 1200 });
    }
  });

  it('deduplicates pending and completed jobs across snapshot IDs and quote-only changes', async () => {
    const s = await setup(1);
    const first = s.scheduler.schedule(s.snapshot);
    const changed = { ...s.snapshot, id: 'another-input-reference', candidates: s.snapshot.candidates.map(candidate => ({ ...candidate,
      quote: { ...candidate.quote!, price: 20 } })) };
    expect(s.scheduler.schedule(changed)).toBe(first);
    const result = await first;
    expect(s.scheduler.schedule(changed)).toBe(first);
    expect(await first).toBe(result); expect(s.api.getBars).toHaveBeenCalledTimes(1);
  });

  it('admits a new completed-bar generation after the five-minute refresh limit', async () => {
    const s = await setup(1); await s.scheduler.schedule(s.snapshot);
    const time = s.now + 300_000, snapshot = refreshed(s.snapshot, time);
    s.setNow(time); s.scheduler.setContext({ ...s.context, data: snapshot.data });
    expect(batch(await s.scheduler.schedule(snapshot)).dataCutoff).toBe(snapshot.dataCutoff);
    expect(s.api.getBars).toHaveBeenCalledTimes(2);
  });

  it('invalidates changed inputs during cooldown without launching replacement work', async () => {
    const s = await setup(1);
    s.api.getBars.mockImplementation(() => new Promise(() => {}));
    const pending = s.scheduler.schedule(s.snapshot); await flush();
    const changed = { ...s.snapshot, candidates: s.snapshot.candidates.map(candidate => ({ ...candidate, asset: { ...candidate.asset, id: 'replacement-listing' } })) };
    expect(await s.scheduler.schedule(changed)).toMatchObject({ status: 'blocked', reasonCode: 'refresh_limited' });
    expect(await pending).toMatchObject({ status: 'cancelled' }); expect(s.api.getBars).toHaveBeenCalledTimes(1);
  });

  it.each(['account', 'session', 'connection', 'feed', 'disconnect', 'adapter', 'dispose', 'cancel'] as const)('detaches pending history on %s changes and rejects late results', async change => {
    const s = await setup(1);
    let release!: (value: Awaited<ReturnType<typeof s.api.getBars>>) => void;
    s.api.getBars.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const pending = s.scheduler.schedule(s.snapshot); await flush();
    const oldSignal = s.api.getBars.mock.calls[0][2];
    const next: UniverseContext = change === 'account' ? { ...s.context, scope: { ...s.context.scope, accountId: 'replacement' } }
      : change === 'session' ? { ...s.context, tradingDate: '2026-09-22' }
      : change === 'connection' ? { ...s.context, connectionGeneration: 2 }
      : change === 'feed' ? { ...s.context, data: { ...s.context.data, feed: null } }
      : { ...s.context, data: { ...s.context.data, status: 'disconnected' } };
    if (change === 'dispose') s.scheduler.dispose();
    else if (change === 'cancel') s.scheduler.cancel();
    else if (change === 'adapter') s.scheduler.setContext(s.context, { getBars: vi.fn() });
    else s.scheduler.setContext(next);
    expect(await pending).toMatchObject({ status: 'cancelled' }); expect(oldSignal!.aborted).toBe(true);
    const progress = s.scheduler.getProgress(); release({ S0000: [] }); await flush();
    expect(s.scheduler.getProgress()).toEqual(progress);
  });

  it('bounds a non-cooperative provider with a wall-clock timer', async () => {
    vi.useFakeTimers(); const s = await setup(1);
    s.api.getBars.mockImplementation(() => new Promise(() => {}));
    const pending = s.scheduler.schedule(s.snapshot); await flush();
    await vi.advanceTimersByTimeAsync(TREND_RESEARCH_POLICY.limits.durationMs);
    expect(await pending).toMatchObject({ status: 'failed', reasonCode: 'research_timeout' });
    expect(s.scheduler.getProgress()).toMatchObject({ status: 'failed', reasonCode: 'research_timeout' });
  });

  it('allows an execution-priority timer to cancel between search simulations', async () => {
    const s = await setup(2);
    const pending = s.scheduler.schedule(s.snapshot);
    let progressAtCancellation = 0;
    await new Promise<void>(resolve => {
      const poll = () => {
        const progress = s.scheduler.getProgress();
        if (progress.testedCandidates > 0) {
          progressAtCancellation = progress.testedCandidates; s.scheduler.cancel(); resolve();
        } else setTimeout(poll, 0);
      };
      setTimeout(poll, 0);
    });
    expect(await pending).toMatchObject({ status: 'cancelled' });
    expect(progressAtCancellation).toBeGreaterThan(0); expect(progressAtCancellation).toBeLessThan(66);
    const final = s.scheduler.getProgress(); await new Promise(resolve => setTimeout(resolve, 5));
    expect(s.scheduler.getProgress()).toEqual(final);
  });

  it.each(['empty', 'three_sessions', 'short_sessions', 'falling', 'failed_holdout'] as const)('returns no candidate for %s history', async kind => {
    const s = await setup(2);
    s.api.getBars.mockImplementation(async (symbols, options) => Object.fromEntries(symbols.map(symbol => {
      let bars = s.history(kind === 'falling' ? 'S0000' : symbol, options);
      if (kind === 'empty') bars = [];
      if (kind === 'three_sessions') bars = bars.filter(bar => bar.t.slice(0, 10) >= '2026-09-16');
      if (kind === 'short_sessions') bars = bars.filter(bar => Date.parse(bar.t) % 86_400_000 < 15 * 3_600_000);
      if (kind === 'failed_holdout') bars = bars.map(bar => bar.t.slice(0, 10) >= '2026-09-17' ? { ...bar, o: 100, c: 100, h: 100.01, l: 99.99 } : bar);
      return [symbol, bars];
    })));
    const result = batch(await s.scheduler.schedule(s.snapshot));
    expect(result.counts.selectedSymbols).toBe(0); expect(result.evaluations.every(value => value.candidate === null)).toBe(true);
    expect(result.evaluations.every(value => value.reason.length > 0)).toBe(true);
  });

  it.each(['oversized', 'future', 'extra_symbol', 'malformed', 'failure'] as const)('preserves unavailable history for %s provider output', async kind => {
    const s = await setup(1);
    s.api.getBars.mockImplementation(async (_symbols, options): Promise<Record<string, ScannerBar[]>> => {
      const rows = s.history('S0000', options);
      if (kind === 'failure') throw new Error('provider credential-containing error that must not be exposed');
      if (kind === 'oversized') return { S0000: Array.from({ length: 1201 }, () => rows[0]) };
      if (kind === 'future') return { S0000: [{ ...rows[0], t: new Date(s.now).toISOString() }] };
      if (kind === 'extra_symbol') return { S0000: rows, UNKNOWN: rows };
      return { S0000: [{ ...rows[0], c: NaN }] };
    });
    const result = batch(await s.scheduler.schedule(s.snapshot));
    expect(result.evaluations[0]).toMatchObject({ status: 'unavailable', search: null, candidate: null });
    expect(JSON.stringify(result)).not.toContain('credential-containing');
  });

  it('keeps success and per-symbol failure independently inspectable', async () => {
    const s = await setup(2);
    s.api.getBars.mockImplementation(async (symbols, options) => {
      if (symbols[0] === 'S0000') throw new Error('Unavailable');
      return { [symbols[0]]: s.history(symbols[0], options) };
    });
    expect(batch(await s.scheduler.schedule(s.snapshot)).evaluations.map(value => value.status)).toEqual(['selected', 'unavailable']);
  });

  it('accepts an empty universe without history requests or candidates', async () => {
    const s = await setup(0);
    expect(batch(await s.scheduler.schedule(s.snapshot)).evaluations).toEqual([]); expect(s.api.getBars).not.toHaveBeenCalled();
  });

  it('rechecks template eligibility instead of trusting a stale eligible flag', async () => {
    const s = await setup(1);
    const snapshot = { ...s.snapshot, candidates: s.snapshot.candidates.map(candidate => ({ ...candidate, quote: null })) };
    expect(batch(await s.scheduler.schedule(snapshot)).evaluations[0]).toMatchObject({ status: 'rejected', reasonCode: 'trade_unavailable' });
    expect(s.api.getBars).not.toHaveBeenCalled();
  });

  it('rejects shortened historical sessions rather than inventing calendar-adjusted evidence', async () => {
    const s = await setup(1);
    const snapshot = { ...s.snapshot, previousSessions: s.snapshot.previousSessions.map(session => session.tradingDate === '2026-09-18'
      ? { ...session, closeAt: '2026-09-18T17:00:00.000Z' } : session) };
    expect(batch(await s.scheduler.schedule(snapshot)).evaluations[0]).toMatchObject({ status: 'unavailable', reasonCode: 'unsupported_history_sessions' });
  });

  it.each(['scope', 'connection', 'live', 'future', 'stale', 'session_closed', 'invalid_schema', 'duplicate', 'oversized'] as const)('blocks %s snapshots before reads', async kind => {
    const s = await setup(1);
    let snapshot = structuredClone(s.snapshot);
    if (kind === 'scope') snapshot = { ...snapshot, scope: { ...snapshot.scope, accountId: 'other' } };
    if (kind === 'connection') snapshot = { ...snapshot, connectionGeneration: 2 };
    if (kind === 'live') snapshot = { ...snapshot, scope: { ...snapshot.scope, environment: 'live' } };
    if (kind === 'future') snapshot = refreshed(snapshot, s.now + 1);
    if (kind === 'stale') s.setNow(s.now + 60_001);
    if (kind === 'session_closed') s.setNow(Date.parse(snapshot.session.closeAt));
    if (kind === 'invalid_schema') snapshot = { ...snapshot, schemaVersion: 2 } as unknown as UniverseSnapshot;
    if (kind === 'duplicate') snapshot = { ...snapshot, candidates: [snapshot.candidates[0], snapshot.candidates[0]] };
    if (kind === 'oversized') snapshot = { ...snapshot, candidates: Array.from({ length: 31 }, () => snapshot.candidates[0]) };
    expect(await s.scheduler.schedule(snapshot)).toMatchObject({ status: 'blocked' }); expect(s.api.getBars).not.toHaveBeenCalled();
  });

  it.each(['clock_rollback', 'clock_deadline', 'data_expiry'] as const)('fences results when %s occurs during a read', async kind => {
    const s = await setup(1);
    s.api.getBars.mockImplementation(async () => {
      s.setNow(kind === 'clock_rollback' ? s.now - 1 : kind === 'clock_deadline' ? s.now + 20_000 : s.now + 10_000);
      return { S0000: [] };
    });
    const snapshot = kind === 'data_expiry' ? { ...s.snapshot, data: { ...s.snapshot.data, validUntil: new Date(s.now + 1000).toISOString() } } : s.snapshot;
    expect(await s.scheduler.schedule(snapshot)).toMatchObject({ status: kind === 'clock_deadline' ? 'failed' : 'cancelled' });
  });

  it('detaches input values before asynchronous reads and preserves exact provenance', async () => {
    const s = await setup(2), mutable = structuredClone(s.snapshot);
    const pending = s.scheduler.schedule(mutable);
    (mutable.candidates[0].asset as { symbol: string }).symbol = 'MUTATED';
    const result = batch(await pending);
    expect(result.evaluations[0].symbol).toBe('S0001'); expect(result.history).toMatchObject({ feed: 'sip', adjustment: 'split', timeframe: '5Min' });
  });

  it('late old-account completion cannot replace an admitted new-account result', async () => {
    const s = await setup(1);
    let release!: (value: Record<string, ScannerBar[]>) => void;
    s.api.getBars.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const old = s.scheduler.schedule(s.snapshot); await flush();
    const now = s.now + 300_000, scope = { ...s.context.scope, accountId: 'new-account' };
    const snapshot = { ...refreshed(s.snapshot, now), scope };
    const replacement = { getBars: vi.fn(async () => ({ S0000: [] })) };
    s.setNow(now); s.scheduler.setContext({ ...s.context, scope, data: snapshot.data }, replacement);
    const result = batch(await s.scheduler.schedule(snapshot));
    expect(result.scope).toEqual(scope); expect(await old).toMatchObject({ status: 'cancelled' });
    const progress = s.scheduler.getProgress(); release({ S0000: [] }); await flush();
    expect(s.scheduler.getProgress()).toEqual(progress); expect(replacement.getBars).toHaveBeenCalledTimes(1);
  });

  it('invalid replacement context cancels existing work and cannot retain the old account', async () => {
    const s = await setup(1); s.api.getBars.mockImplementation(() => new Promise(() => {}));
    const pending = s.scheduler.schedule(s.snapshot); await flush();
    expect(() => s.scheduler.setContext({ ...s.context, connectionGeneration: NaN })).toThrow();
    expect(await pending).toMatchObject({ status: 'cancelled' });
    expect(await s.scheduler.schedule(s.snapshot)).toMatchObject({ status: 'blocked' });
  });
});
