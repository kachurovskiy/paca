import { describe, expect, it } from 'vitest';
import type { Bar } from '../../core/types';
import { canonicalSerialize } from './values';
import type { RobotSession } from '../domain';
import { chronologicalFolds, evaluateChronological, researchReader, runChronological,
  type ResearchRequest, type ResearchSimulator, type ResearchSeries } from './chronological';
import { CHRONOLOGICAL_RESEARCH_POLICY as policy } from './policy';

/** Synthetic software fixtures, not market history or forecasting evidence. */
function fixture(days = 20, symbols = ['AAA']) {
  const series: ResearchSeries[] = [], start = Date.parse('2026-01-05T00:00:00.000Z');
  for (let day = 0, added = 0; added < days; day++) {
    const time = start + day * 86400_000, weekday = new Date(time).getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    added++;
    const tradingDate = new Date(time).toISOString().slice(0, 10), open = time + 14.5 * 3600_000;
    const session: RobotSession = { calendarId: 'synthetic-calendar', tradingDate, timeZone: 'America/New_York',
      openAt: new Date(open).toISOString(), closeAt: new Date(open + 390 * 60_000).toISOString(),
      calendarAsOf: new Date(time).toISOString(), provenanceRef: 'synthetic-calendar-source' };
    for (const symbol of symbols) series.push({ symbol, session, bars: Array.from({ length: 78 }, (_, i) => ({
      bar: { t: new Date(open + i * 300_000).toISOString(), o: 100 + i / 100, h: 102, l: 99, c: 101 + i / 100, v: 1000 },
      availableAt: new Date(open + (i + 1) * 300_000).toISOString() })) });
  }
  const cutoff = series[series.length - 1].session.closeAt;
  return { data: { id: 'synthetic-dataset', sourceRef: 'synthetic-source', asOf: cutoff, dataCutoff: cutoff,
    series, selection: { kind: 'supplied_symbols' as const } },
  configurations: ['a', 'b', 'c'].map((id, index) => ({ id, parameters: { gain: 1 + index / 10 }, neighbors: ['a', 'b', 'c'].filter(n => n !== id) })),
  priorExposure: [] as { sourceRef: string; tradingDate: string }[], exposureHistoryComplete: true };
}
const simulate: ResearchSimulator = (configuration, reader, cost) => {
  const bars = reader.bars(reader.cutoff);
  return { grossReturnPct: configuration.parameters.gain * bars.length / 78, trades: 1, turnover: 2, fillModel: cost.id };
};
function run(request: ResearchRequest, kernel = simulate) {
  const job = evaluateChronological(request, kernel); let step = job.next();
  while (!step.done) step = job.next();
  return step.value;
}

describe('chronological experimental research policy', () => {
  it('builds expanding earlier training and disjoint later validation from independent dates', () => {
    const days = fixture().data.series.map(s => s.session.tradingDate), folds = chronologicalFolds([...days].reverse());
    expect(folds).toHaveLength(2);
    expect(folds[0].training).toEqual(days.slice(0, 10)); expect(folds[0].validation).toEqual(days.slice(10, 15));
    expect(folds[1].training).toEqual(days.slice(0, 15)); expect(folds[1].validation).toEqual(days.slice(15));
    expect(() => chronologicalFolds([...days, days[0]])).toThrow('duplicates');
  });
  it('deterministically replays pinned configs/policy, all training losers, and explicit baselines without upgrading evidence', () => {
    const request = fixture(), before = structuredClone(request), result = run(request);
    expect(canonicalSerialize(result)).toBe(canonicalSerialize(run(request))); expect(request).toEqual(before);
    expect(result.policy).toEqual(policy); expect(result.configurations).toEqual(request.configurations);
    expect(result.status).toBe('complete'); expect(result.gates).toBe('passed');
    expect(result.evidenceStatus).toBe('experimental'); expect(result.pipelineValidated).toBe(false);
    expect(result.forecast.status).toBe('unavailable'); expect(result.forecast.meanPnlCents).toBeNull();
    expect(result.breadth.testedConfigurations).toBe(3); expect(result.breadth.independentValidationSessions).toBe(10);
    expect(result.folds.every(f => f.training.length === 3 && f.selectedConfigurationId === 'c')).toBe(true);
    const cash = result.evaluations.filter(e => e.configurationId === 'cash-zero-interest');
    expect(cash).toHaveLength(20); expect(cash.every(e => e.netReturnPct === 0 && e.trades === 0)).toBe(true);
    const hold = result.evaluations.find(e => e.configurationId === 'session-buy-and-hold' && e.scenarioId === 'observed-next')!;
    expect(hold.netReturnPct).toBeCloseTo((101.77 / 100 - 1) * 100 - 0.1);
    
  });
  it('labels an explicitly retrospective calendar without pretending pre-open availability or full-pipeline validation', () => {
    const request = fixture(), retrospective = { ...request, data: { ...request.data, calendarEvidence: 'retrospective' as const,
      series: request.data.series.map(s => ({ ...s, session: { ...s.session, calendarAsOf: request.data.dataCutoff } })) } };
    const result = run(retrospective); expect(result.gates).toBe('passed'); expect(result.calendarClaim).toBe('retrospective_calendar');
    expect(result.symbolClaim).toBe('conditional_on_supplied_symbols'); expect(result.pipelineValidated).toBe(false);
    const { calendarEvidence: _flag, ...without } = retrospective.data;
    expect(run({ ...request, data: without }).reasons).toContain('future_session_or_calendar');
    retrospective.data.series[0].session.calendarAsOf = new Date(Date.parse(request.data.dataCutoff) + 1).toISOString();
    expect(run(retrospective).reasons).toContain('future_session_or_calendar');
    expect(run({ ...request, data: { ...retrospective.data, selection: { kind: 'point_in_time', snapshots: [] } } }).reasons)
      .toContain('retrospective_calendar_not_point_in_time');
  });
  it('does not rerank the training winner after later validation rejects it', () => {
    const request = fixture(), firstValidation = request.data.series[10].session.tradingDate;
    const result = run(request, (config, reader, cost) => ({ grossReturnPct:
      reader.session.tradingDate >= firstValidation && config.id === 'c' ? -2 : config.parameters.gain,
    trades: 1, turnover: 2, fillModel: cost.id }));
    expect(result.folds[0].selectedConfigurationId).toBe('c'); expect(result.folds[0].status).toBe('rejected');
    expect(result.folds[0].reasons).toContain('does_not_beat_cash'); expect(result.gates).toBe('failed');
    expect(new Set(result.evaluations.filter(e => e.foldId === 'fold-1' && e.phase === 'validation').map(e => e.configurationId))).toEqual(new Set(['c']));
    // Only a later fold may select again, using that fold's now-earlier observations.
    expect(result.folds[1].training).toHaveLength(3);
  });
  it('does not expose later observations or validation handles through a training reader', () => {
    const request = fixture(), series = request.data.series[0], view = researchReader(series, series.session.closeAt);
    expect(view.reader.bars(series.session.openAt)).toEqual([]);
    expect(view.reader.bars(series.bars[0].availableAt)).toHaveLength(1);
    expect(() => view.reader.bars(request.data.dataCutoff)).toThrow('future_data_access');
    expect(view.violation()).toBe('future_data_access');
    const result = run(request, (_config, reader, cost) => {
      try { reader.bars(request.data.dataCutoff); } catch { /* Cannot turn a caught future read into a passing score. */ }
      return { grossReturnPct: 5, trades: 1, turnover: 2, fillModel: cost.id };
    });
    expect(result.folds[0].selectedConfigurationId).toBeNull();
    expect(result.evaluations[0].reason).toBe('future_data_access'); expect(result.evaluations[0].netReturnPct).toBeNull();
  });
  it('keeps repeated observation reads detached without exposing later arrivals', () => {
    const request = fixture(), series = request.data.series[0], view = researchReader(series, series.session.closeAt);
    const at = series.bars[0].availableAt, bars = view.reader.bars(at);
    expect(bars).toHaveLength(1);
    (bars[0] as Bar).c = -1;
    expect(view.reader.bars(at)[0].c).toBe(series.bars[0].bar.c);
    expect(view.reader.bars(series.session.openAt)).toEqual([]);
    expect(view.violation()).toBeNull();
  });
  it('keeps supplied-symbol history conditional and rejects retrospective selection snapshots', () => {
    const request = fixture(); expect(run(request).symbolClaim).toBe('conditional_on_supplied_symbols');
    const snapshots = request.data.series.map(s => ({ id: `snapshot/${s.session.tradingDate}`, selectorId: 'synthetic-selector',
      tradingDate: s.session.tradingDate, asOf: s.session.openAt, dataCutoff: s.session.calendarAsOf, members: ['AAA', 'BBB'], selected: ['AAA'] }));
    const pointInTime = { ...request, data: { ...request.data, selection: { kind: 'point_in_time' as const, snapshots } } };
    expect(run(pointInTime).symbolClaim).toBe('recorded_selection_replay'); expect(run(pointInTime).pipelineValidated).toBe(false);
    snapshots[0].asOf = request.data.dataCutoff;
    expect(run(pointInTime).reasons).toContain('selected_symbol_leakage');
    snapshots[0].asOf = request.data.series[0].session.openAt; snapshots[0].selected = ['BBB'];
    expect(run(pointInTime).reasons).toContain('selection_membership_mismatch');
    snapshots.pop(); expect(run(pointInTime).reasons).toContain('missing_selection_history');
  });
  it('reports reused final data as exhausted even after configuration renaming, and incomplete exposure as unknown', () => {
    const request = fixture(), first = run(request); expect(first.holdout).toBe('untouched_relative_to_supplied_history');
    request.priorExposure = [...first.exposure];
    request.data.sourceRef = 'renamed-synthetic-source'; request.data.id = 'renamed-synthetic-data';
    request.configurations = request.configurations.map(c => ({ ...c, id: `renamed-${c.id}`, neighbors: c.neighbors.map(id => `renamed-${id}`) }));
    const repeated = run(request); expect(repeated.holdout).toBe('exhausted'); expect(repeated.gates).toBe('failed');
    expect(repeated.reasons).toContain('holdout_exhausted');
    request.priorExposure = []; request.exposureHistoryComplete = false;
    expect(run(request).holdout).toBe('unknown'); expect(run(request).gates).toBe('failed');
  });
  it('counts independent sessions rather than symbols or repeated trades', () => {
    const result = run(fixture(15, ['AAA', 'BBB', 'CCC', 'DDD']));
    expect(result.status).toBe('unavailable'); expect(result.reasons).toContain('insufficient_independent_sessions');
    expect(result.evaluations).toHaveLength(0);
    const noTrades = run(fixture(), (_config, _reader, cost) => ({ grossReturnPct: 0, turnover: 0, trades: 0, fillModel: cost.id }));
    expect(noTrades.folds.every(f => f.status === 'rejected')).toBe(true);
    expect(noTrades.folds[0].training[0].reasons).toContain('insufficient_trades');
  });
  it('retains failed configurations and refuses excessive search breadth', () => {
    const request = fixture(), result = run(request, (config, reader, cost) => config.id === 'a'
      ? { unavailable: 'synthetic_missing_fill_model' } : simulate(config, reader, cost));
    expect(result.breadth.testedConfigurations).toBe(3);
    expect(result.folds[0].training.find(c => c.configurationId === 'a')?.reasons).toContain('synthetic_missing_fill_model');
    expect(result.evaluations.some(e => e.reason === 'synthetic_missing_fill_model' && e.netReturnPct === null)).toBe(true);
    request.configurations = Array.from({ length: 17 }, (_, i) => ({ id: `c${i}`, parameters: { gain: 1 }, neighbors: ['a', 'b'] }));
    const excessive = run(request); expect(excessive.reasons).toContain('configuration_budget'); expect(excessive.evaluations).toEqual([]);
  });
  it('rejects distant or multi-axis alternatives masquerading as parameter neighbors', () => {
    const request = fixture(); request.configurations[0].parameters.gain = 100;
    expect(run(request).reasons).toContain('neighbor_distance');
    const twoAxes = fixture();
    const configurations = twoAxes.configurations.map((c, i) => ({ ...c, parameters: { ...c.parameters, stop: 1 + i / 10 } }));
    expect(run({ ...twoAxes, configurations }).reasons).toContain('neighbor_axes');
    request.configurations[0].parameters.gain = NaN;
    expect(run(request).status).toBe('unavailable'); expect(run(request).configurations).toEqual([]);
  });
  it('bounds folds and records unused later sessions rather than implying they were tested', () => {
    const request = fixture(40), result = run(request);
    expect(result.folds).toHaveLength(policy.limits.folds);
    expect(result.breadth.suppliedSessions).toBe(40); expect(result.breadth.unusedSessions).toHaveLength(10);
    expect(result.breadth.evaluations).toBeLessThan(policy.limits.evaluations);
  });
  it('rejects unstable neighboring parameters and explicit cost/fill stress failures', () => {
    const request = fixture(), validationFrom = request.data.series[10].session.tradingDate;
    const unstable = run(request, (config, reader, cost) => ({ grossReturnPct:
      config.id !== 'c' && reader.session.tradingDate >= validationFrom ? -2 : config.parameters.gain,
    trades: 1, turnover: 2, fillModel: cost.id }));
    expect(unstable.folds[0].reasons).toContain('neighbor_instability');
    const costs = run(request, (_config, _reader, cost) => ({ grossReturnPct: 0.2, trades: 1, turnover: 2, fillModel: cost.id }));
    expect(costs.evaluations.find(e => e.phase === 'validation')?.netReturnPct).toBeCloseTo(0.1);
    expect(costs.evaluations.find(e => e.phase === 'stress')?.netReturnPct).toBeCloseTo(-0.1);
    expect(costs.folds[0].reasons).toContain('cost_or_fill_sensitive');
    const fills = run(request, (config, reader, cost) => cost.observationDelay === 2
      ? { unavailable: 'delayed_fill_unsupported' } : simulate(config, reader, cost));
    expect(fills.folds[0].reasons).toContain('cost_or_fill_sensitive');
    expect(fills.evaluations.some(e => e.reason === 'delayed_fill_unsupported')).toBe(true);
  });
  it.each(['coverage', 'gap', 'future', 'unfinished', 'source', 'missing-symbol'] as const)('does not fill missing or invalid data: %s', problem => {
    const request = structuredClone(fixture(20, ['AAA', 'BBB']));
    const series = request.data.series[0], bars = [...series.bars];
    if (problem === 'coverage') bars.splice(0, 30);
    if (problem === 'gap') bars.splice(20, 3);
    if (problem === 'future') bars[0] = { ...bars[0], availableAt: '2027-01-01T00:00:00.000Z' };
    if (problem === 'unfinished') bars[0] = { ...bars[0], availableAt: bars[0].bar.t };
    if (problem === 'source') request.data.asOf = request.data.series[0].session.openAt;
    request.data.series[0] = { ...series, bars };
    if (problem === 'missing-symbol') request.data.series.pop();
    const result = run(request); expect(result.status).toBe('unavailable'); expect(result.gates).toBe('failed');
    expect(result.evaluations).toEqual([]); expect(result.forecast.meanPnlCents).toBeNull();
  });
  it('supports authoritative shortened sessions without pretending they are full-length history', () => {
    const request = fixture(); request.data.series = request.data.series.map(s => ({ ...s,
      session: { ...s.session, closeAt: new Date(Date.parse(s.session.openAt) + 210 * 60_000).toISOString() }, bars: s.bars.slice(0, 42) }));
    expect(run(request).status).toBe('complete');
  });
  it('does not invent an open or close for an otherwise sufficiently covered buy-hold baseline', () => {
    const request = fixture(); request.data.series[10] = { ...request.data.series[10], bars: request.data.series[10].bars.slice(1) };
    const result = run(request); expect(result.status).toBe('complete'); expect(result.gates).toBe('failed');
    expect(result.folds[0].reasons).toContain('baseline_unavailable');
    expect(result.evaluations.find(e => e.configurationId === 'session-buy-and-hold')?.netReturnPct).toBeNull();
  });
  it('yields before simulations and preserves partial failures/exposure on cancellation or deadline', async () => {
    const request = fixture(), controller = new AbortController(); let calls = 0, yields = 0;
    const result = await runChronological(request, (config, reader, cost) => { calls++; return simulate(config, reader, cost); },
      { signal: controller.signal, now: () => 0, yieldTask: async () => { if (++yields === 4) controller.abort(); } });
    expect(calls).toBe(3); expect(result.status).toBe('cancelled'); expect(result.evaluations).toHaveLength(3);
    expect(result.exposure).toHaveLength(3); expect(result.gates).toBe('failed');
    let now = 0;
    const deadline = await runChronological(request, simulate, { now: () => now, yieldTask: async () => { now += policy.limits.durationMs; } });
    expect(deadline.status).toBe('budget_exceeded'); expect(deadline.reasons).toContain('duration_budget'); expect(deadline.evaluations).toEqual([]);
  });
});
