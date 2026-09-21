import type { Bar } from '../../core/types';
import { yieldTask as yieldToBrowser } from '../../core/task';
import { unavailableForecast } from './values';
import type { RobotSession } from '../domain';
import { validSession } from '../templates/common';
import { identifier, instant } from '../../core/validation';
import { CHRONOLOGICAL_RESEARCH_POLICY as policy, type ResearchCost } from './policy';

export interface ResearchBar { readonly bar: Readonly<Bar>; readonly availableAt: string; }
export interface ResearchSeries { readonly symbol: string; readonly session: RobotSession; readonly bars: readonly ResearchBar[]; }
export interface SelectionSnapshot {
  readonly id: string; readonly tradingDate: string; readonly selectorId: string;
  readonly asOf: string; readonly dataCutoff: string; readonly members: readonly string[]; readonly selected: readonly string[];
}
export interface ChronologicalData {
  readonly id: string; readonly sourceRef: string; readonly asOf: string; readonly dataCutoff: string;
  readonly series: readonly ResearchSeries[];
  /** Explicit retrospective calendar evidence; never a pre-session availability claim. */
  readonly calendarEvidence?: 'retrospective';
  readonly selection: { readonly kind: 'supplied_symbols' } |
    { readonly kind: 'point_in_time'; readonly snapshots: readonly SelectionSnapshot[] };
}
export interface ResearchConfiguration {
  readonly id: string; readonly parameters: Readonly<Record<string, number>>; readonly neighbors: readonly string[];
}
export interface ResearchFold { readonly id: string; readonly training: readonly string[]; readonly validation: readonly string[]; }
/** Exposure is data/session based, deliberately independent of policy/config IDs. */
export interface HoldoutExposure { readonly sourceRef: string; readonly tradingDate: string; }
export interface ResearchRequest {
  readonly data: ChronologicalData; readonly configurations: readonly ResearchConfiguration[];
  readonly priorExposure: readonly HoldoutExposure[]; readonly exposureHistoryComplete: boolean;
}
export interface SimulationResult {
  readonly grossReturnPct: number; readonly turnover: number; readonly trades: number;
  /** Explicit acknowledgement; an unsupported fill model must return unavailable. */
  readonly fillModel: ResearchCost['id'];
}
export interface ResearchReader {
  readonly symbol: string; readonly session: RobotSession; readonly cutoff: string;
  /** Unknown/future reads throw and poison this evaluation even if the kernel catches the error. */
  bars(asOf: string): readonly Readonly<Bar>[];
}
export type ResearchSimulator = (configuration: ResearchConfiguration, reader: ResearchReader, cost: ResearchCost) =>
  SimulationResult | { readonly unavailable: string };
export interface ResearchEvaluation {
  readonly foldId: string; readonly phase: 'training' | 'validation' | 'neighbor' | 'stress' | 'baseline';
  readonly configurationId: string; readonly scenarioId: string; readonly tradingDate: string; readonly symbol: string;
  readonly sourceCutoff: string; readonly readCutoff: string;
  readonly netReturnPct: number | null; readonly trades: number | null; readonly reason: string | null;
}
export interface FoldResult {
  readonly fold: ResearchFold; readonly selectedConfigurationId: string | null;
  readonly training: readonly { readonly configurationId: string; readonly score: number | null; readonly reasons: readonly string[] }[];
  readonly status: 'passed' | 'rejected'; readonly reasons: readonly string[];
}
export interface ChronologicalReport {
  readonly policy: typeof policy; readonly status: 'complete' | 'unavailable' | 'cancelled' | 'budget_exceeded';
  readonly gates: 'passed' | 'failed';
  readonly evidenceStatus: 'experimental' | 'unavailable'; readonly pipelineValidated: false;
  readonly symbolClaim: 'conditional_on_supplied_symbols' | 'recorded_selection_replay';
  readonly calendarClaim: 'as_of_session_open' | 'retrospective_calendar';
  readonly data: { readonly id: string; readonly sourceRef: string; readonly asOf: string; readonly dataCutoff: string };
  readonly selection: ChronologicalData['selection'];
  readonly configurations: readonly ResearchConfiguration[];
  readonly folds: readonly FoldResult[]; readonly evaluations: readonly ResearchEvaluation[];
  readonly breadth: { readonly suppliedConfigurations: number; readonly testedConfigurations: number; readonly evaluations: number;
    readonly suppliedSymbols: number; readonly suppliedSessions: number; readonly unusedSessions: readonly string[];
    readonly independentValidationSessions: number };
  readonly holdout: 'untouched_relative_to_supplied_history' | 'exhausted' | 'unknown';
  readonly exposure: readonly HoldoutExposure[]; readonly reasons: readonly string[];
  readonly forecast: ReturnType<typeof unavailableForecast>;
}

const check = (condition: unknown, reason: string): void => { if (!condition) throw new Error(reason); };
const unique = <T>(items: readonly T[]) => [...new Set(items)];
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const date = (value: string) => instant(`${value}T00:00:00.000Z`, 'tradingDate');
const costPct = (cost: ResearchCost) => (cost.feesBpsPerSide + cost.spreadBpsPerSide + cost.slippageBpsPerSide) / 100;

/** Expanding training, disjoint later validation; symbols never count as extra sessions. */
export function chronologicalFolds(dates: readonly string[]): readonly ResearchFold[] {
  check(dates.length <= policy.limits.sessions && unique(dates).length === dates.length, 'session_count_or_duplicates');
  dates.forEach(date); const ordered = [...dates].sort(compare), folds: ResearchFold[] = [];
  for (let end = policy.split.initialTrainingSessions; end + policy.split.validationSessions <= ordered.length; end += policy.split.validationSessions) {
    if (folds.length === policy.limits.folds) break;
    folds.push({ id: `fold-${folds.length + 1}`, training: ordered.slice(0, end), validation: ordered.slice(end, end + policy.split.validationSessions) });
  }
  return structuredClone(folds);
}

function validate(request: ResearchRequest): void {
  const { data, configurations } = request;
  identifier(data.id, 'data.id'); identifier(data.sourceRef, 'data.sourceRef');
  instant(data.asOf, 'data.asOf'); instant(data.dataCutoff, 'data.dataCutoff'); check(data.dataCutoff <= data.asOf, 'future_source_cutoff');
  check(data.calendarEvidence === undefined || data.calendarEvidence === 'retrospective', 'unsupported_calendar_evidence');
  check(!(data.calendarEvidence === 'retrospective' && data.selection.kind === 'point_in_time'), 'retrospective_calendar_not_point_in_time');
  check(configurations.length > 0 && configurations.length <= policy.limits.configurations, 'configuration_budget');
  check(unique(configurations.map(c => c.id)).length === configurations.length, 'configuration_ids');
  for (const c of configurations) {
    identifier(c.id, 'configuration.id'); const parameters = Object.values(c.parameters);
    check(parameters.length > 0 && parameters.length <= 20 && parameters.every(Number.isFinite), 'configuration_parameters');
    check(c.neighbors.length >= policy.minimum.neighbors && c.neighbors.length <= policy.limits.configurations
      && unique(c.neighbors).length === c.neighbors.length
      && c.neighbors.every(id => id !== c.id && configurations.some(candidate => candidate.id === id)), 'missing_neighbors');
    for (const id of c.neighbors) {
      const other = configurations.find(candidate => candidate.id === id)!;
      const keys = Object.keys(c.parameters).sort(compare);
      check(JSON.stringify(keys) === JSON.stringify(Object.keys(other.parameters).sort(compare)), 'neighbor_axes');
      const changed = keys.filter(key => c.parameters[key] !== other.parameters[key]);
      check(changed.length === policy.neighborhood.changedAxes, 'neighbor_axes');
      const value = c.parameters[changed[0]], neighbor = other.parameters[changed[0]];
      const step = Number.isInteger(value) && Number.isInteger(neighbor) ? policy.neighborhood.minimumIntegerStep : 1e-9;
      check(Math.abs(value - neighbor) <= Math.max(step, Math.abs(value) * policy.neighborhood.maximumRelativeDistance), 'neighbor_distance');
    }
  }
  check(data.series.length > 0 && data.series.length <= policy.limits.sessions * policy.limits.symbols, 'series_budget');
  check(unique(data.series.map(s => s.symbol)).length <= policy.limits.symbols, 'symbol_budget');
  check(unique(data.series.map(s => `${s.session.tradingDate}/${s.symbol}`)).length === data.series.length, 'duplicate_series');
  const sessions = new Map<string, RobotSession>();
  for (const series of data.series) {
    const s = series.session, bars = series.bars, interval = policy.coverage.intervalMs;
    check(/^[A-Z][A-Z0-9.-]{0,14}$/.test(series.symbol) && validSession(s), 'invalid_series');
    check(s.closeAt <= data.dataCutoff && s.calendarAsOf <= (data.calendarEvidence === 'retrospective' ? data.dataCutoff : s.openAt), 'future_session_or_calendar');
    const prior = sessions.get(s.tradingDate);
    check(!prior || prior.openAt === s.openAt && prior.closeAt === s.closeAt && prior.calendarId === s.calendarId, 'inconsistent_session');
    sessions.set(s.tradingDate, s);
    const open = Date.parse(s.openAt), close = Date.parse(s.closeAt), expected = (close - open) / interval;
    check(bars.length <= policy.limits.barsPerSeries && bars.length >= expected * policy.coverage.fraction, 'data_coverage');
    let previous = open - interval;
    for (const row of bars) {
      const b = row.bar; instant(b.t, 'bar.t'); instant(row.availableAt, 'bar.availableAt');
      const t = Date.parse(b.t);
      check(t >= open && t + interval <= close && t % interval === 0 && t > previous, 'bar_time_or_order');
      check(t - previous <= policy.coverage.maximumGapMs, 'data_gap'); previous = t;
      check(Date.parse(row.availableAt) >= t + interval && row.availableAt <= data.dataCutoff, 'future_or_unfinished_bar');
      check([b.o, b.h, b.l, b.c, b.v].every(Number.isFinite) && Math.min(b.o, b.h, b.l, b.c) > 0 && b.v >= 0
        && b.l <= Math.min(b.o, b.c) && b.h >= Math.max(b.o, b.c), 'invalid_bar');
    }
    check(close - previous <= policy.coverage.maximumGapMs, 'data_gap');
  }
  check(sessions.size <= policy.limits.sessions, 'session_budget');
  if (data.selection.kind === 'supplied_symbols') {
    const symbolCount = unique(data.series.map(s => s.symbol)).length;
    check([...sessions.keys()].every(day => data.series.filter(s => s.session.tradingDate === day).length === symbolCount), 'missing_symbol_session');
  }
  const ordered = [...sessions.values()].sort((a, b) => compare(a.openAt, b.openAt));
  check(ordered.every((s, i) => i === 0 || ordered[i - 1].closeAt < s.openAt), 'overlapping_sessions');
  if (data.selection.kind === 'point_in_time') {
    const snapshots = data.selection.snapshots;
    check(snapshots.length === sessions.size && unique(snapshots.map(s => s.tradingDate)).length === snapshots.length, 'missing_selection_history');
    for (const snapshot of snapshots) {
      identifier(snapshot.id, 'snapshot.id'); identifier(snapshot.selectorId, 'selectorId');
      instant(snapshot.asOf, 'snapshot.asOf'); instant(snapshot.dataCutoff, 'snapshot.dataCutoff');
      const session = sessions.get(snapshot.tradingDate);
      check(!!session && snapshot.dataCutoff <= snapshot.asOf && snapshot.asOf <= session.openAt, 'selected_symbol_leakage');
      const symbols = data.series.filter(s => s.session.tradingDate === snapshot.tradingDate).map(s => s.symbol).sort(compare);
      check(snapshot.members.length <= 600 && unique(snapshot.members).length === snapshot.members.length
        && snapshot.selected.every(s => snapshot.members.includes(s))
        && JSON.stringify([...snapshot.selected].sort(compare)) === JSON.stringify(symbols), 'selection_membership_mismatch');
    }
  }
  check(request.priorExposure.length <= 10_000, 'exposure_budget');
  for (const exposure of request.priorExposure) { identifier(exposure.sourceRef, 'exposure.sourceRef'); date(exposure.tradingDate); }
}

/** Guarded views have no dataset/validation handle. A failed future read cannot be swallowed into a successful score. */
export function researchReader(series: ResearchSeries, cutoff: string): { reader: ResearchReader; violation: () => string | null } {
  let violation: string | null = null;
  const reader = Object.freeze({ symbol: series.symbol, session: structuredClone(series.session), cutoff,
    bars: (asOf: string): readonly Readonly<Bar>[] => {
      try {
        instant(asOf, 'read.asOf'); check(asOf >= series.session.openAt && asOf <= cutoff && asOf <= series.session.closeAt, 'future_data_access');
        // Bar fields are primitive values. Detached copies preserve reader isolation
        // without repeatedly serializing every growing prefix during simulation.
        return series.bars.filter(row => row.availableAt <= asOf).map(({ bar }) => ({ t: bar.t, o: bar.o, h: bar.h, l: bar.l, c: bar.c, v: bar.v }));
      } catch { violation = 'future_data_access'; throw new Error(violation); }
    } });
  return { reader, violation: () => violation };
}

/** Pure generator: each yield precedes one bounded kernel call. Driver owns yielding/cancellation.
 * No broker, persistence, UI, current clock, or experimental-proposal mutation. */
export function* evaluateChronological(request: ResearchRequest, simulate: ResearchSimulator): Generator<void, ChronologicalReport> {
  const evaluations: ResearchEvaluation[] = [], results: FoldResult[] = [], exposure: HoldoutExposure[] = [];
  const reasons: string[] = []; let holdout: ChronologicalReport['holdout'] = 'unknown', validated = false;
  const finish = (status: ChronologicalReport['status']): ChronologicalReport => structuredClone({ policy, status,
    gates: status === 'complete' && !reasons.length && results.every(f => f.status === 'passed') ? 'passed' : 'failed',
    evidenceStatus: status === 'complete' ? 'experimental' : 'unavailable', pipelineValidated: false,
    calendarClaim: request.data.calendarEvidence === 'retrospective' ? 'retrospective_calendar' : 'as_of_session_open',
    symbolClaim: request.data.selection.kind === 'point_in_time' ? 'recorded_selection_replay' : 'conditional_on_supplied_symbols',
    data: { id: request.data.id, sourceRef: request.data.sourceRef, asOf: request.data.asOf, dataCutoff: request.data.dataCutoff },
    selection: request.data.selection,
    configurations: validated ? request.configurations : [], folds: results, evaluations,
    breadth: { suppliedConfigurations: request.configurations.length,
      testedConfigurations: unique(evaluations.filter(e => e.phase === 'training').map(e => e.configurationId)).length,
      evaluations: evaluations.length, suppliedSymbols: unique(request.data.series.map(s => s.symbol)).length,
      suppliedSessions: unique(request.data.series.map(s => s.session.tradingDate)).length,
      unusedSessions: unique(request.data.series.map(s => s.session.tradingDate)).filter(day => !exposure.some(e => e.tradingDate === day)).sort(compare),
      independentValidationSessions: unique(evaluations.filter(e => e.phase === 'validation').map(e => e.tradingDate)).length },
    holdout, exposure, reasons, forecast: unavailableForecast('Chronological research is experimental evidence, not a calibrated session-end forecast.') });
  try { validate(request); request = structuredClone(request); validated = true; }
  catch (error) { reasons.push(error instanceof Error ? error.message : 'invalid_input'); return finish('unavailable'); }
  const folds = chronologicalFolds(unique(request.data.series.map(s => s.session.tradingDate)));
  if (folds.length < policy.split.minimumFolds) { reasons.push('insufficient_independent_sessions'); return finish('unavailable'); }
  const finalDates = folds[folds.length - 1].validation;
  holdout = !request.exposureHistoryComplete ? 'unknown' : request.priorExposure.some(e =>
    finalDates.includes(e.tradingDate)) ? 'exhausted' : 'untouched_relative_to_supplied_history';
  if (holdout !== 'untouched_relative_to_supplied_history') reasons.push(`holdout_${holdout}`);
  const configs = [...request.configurations].sort((a, b) => compare(a.id, b.id));
  function* evaluate(fold: ResearchFold, phase: ResearchEvaluation['phase'], config: ResearchConfiguration,
    cost: ResearchCost, dates: readonly string[]): Generator<void, ResearchEvaluation[]> {
    const rows: ResearchEvaluation[] = [];
    for (const series of request.data.series.filter(s => dates.includes(s.session.tradingDate))
      .sort((a, b) => compare(a.session.tradingDate, b.session.tradingDate) || compare(a.symbol, b.symbol))) {
      check(evaluations.length < policy.limits.evaluations, 'evaluation_budget'); yield;
      const cutoff = series.session.closeAt, view = researchReader(series, cutoff);
      let netReturnPct: number | null = null, trades: number | null = null, reason: string | null = null;
      try {
        const value = simulate(config, view.reader, cost);
        if ('unavailable' in value) reason = value.unavailable || 'simulation_unavailable';
        else {
          check(value.fillModel === cost.id && Number.isFinite(value.grossReturnPct) && Number.isFinite(value.turnover)
            && value.turnover >= 0 && Number.isSafeInteger(value.trades) && value.trades >= 0
            && (value.trades > 0 ? value.turnover > 0 : value.turnover === 0 && value.grossReturnPct === 0), 'invalid_simulation');
          netReturnPct = value.grossReturnPct - value.turnover * costPct(cost); trades = value.trades;
          check(Number.isFinite(netReturnPct), 'invalid_simulation');
        }
      } catch (error) { reason = error instanceof Error ? error.message : 'simulation_failed'; }
      reason = view.violation() ?? reason;
      if (reason) { netReturnPct = null; trades = null; }
      const row: ResearchEvaluation = { foldId: fold.id, phase, configurationId: config.id, scenarioId: cost.id,
        tradingDate: series.session.tradingDate, symbol: series.symbol, sourceCutoff: request.data.dataCutoff,
        readCutoff: cutoff, netReturnPct, trades, reason };
      rows.push(row); evaluations.push(row);
      if (!exposure.some(e => e.tradingDate === series.session.tradingDate)) exposure.push({ sourceRef: request.data.sourceRef, tradingDate: series.session.tradingDate });
    }
    return rows;
  }
  const summary = (rows: readonly ResearchEvaluation[], minTrades: number) => {
    const issues = unique(rows.flatMap(r => r.reason ? [r.reason] : []));
    const sessions = unique(rows.map(r => r.tradingDate));
    let score = rows.length && !issues.length ? sessions.reduce((sum, session) => {
      const day = rows.filter(r => r.tradingDate === session); return sum + day.reduce((n, r) => n + r.netReturnPct!, 0) / day.length;
    }, 0) / sessions.length : null;
    if (score !== null && !Number.isFinite(score)) { score = null; issues.push('invalid_aggregate'); }
    if (rows.reduce((n, r) => n + (r.trades ?? 0), 0) < minTrades) issues.push('insufficient_trades');
    if (score !== null && score <= 0) issues.push('does_not_beat_cash');
    return { score, reasons: unique(issues) };
  };
  try {
    for (const fold of folds) {
      const training: { configurationId: string; score: number | null; reasons: readonly string[] }[] = [];
      for (const config of configs) training.push({ configurationId: config.id,
        ...summary(yield* evaluate(fold, 'training', config, policy.costs[0], fold.training), policy.minimum.trainingTrades) });
      const ranked = training.filter(t => !t.reasons.length && t.score !== null)
        .sort((a, b) => b.score! - a.score! || compare(a.configurationId, b.configurationId));
      const selected = configs.find(c => c.id === ranked[0]?.configurationId);
      if (!selected) { results.push({ fold, training, selectedConfigurationId: null, status: 'rejected', reasons: ['no_training_candidate'] }); continue; }
      const failures = summary(yield* evaluate(fold, 'validation', selected, policy.costs[0], fold.validation), policy.minimum.validationTrades).reasons;
      const stress = summary(yield* evaluate(fold, 'stress', selected, policy.costs[1], fold.validation), policy.minimum.validationTrades);
      if (stress.reasons.length) failures.push('cost_or_fill_sensitive');
      let stable = 0;
      for (const id of [...selected.neighbors].sort(compare)) {
        const neighbor = summary(yield* evaluate(fold, 'neighbor', configs.find(c => c.id === id)!, policy.costs[0], fold.validation), policy.minimum.validationTrades);
        if (!neighbor.reasons.length) stable++;
      }
      if (stable / selected.neighbors.length < policy.minimum.stableNeighborFraction) failures.push('neighbor_instability');
      for (const series of request.data.series.filter(s => fold.validation.includes(s.session.tradingDate))) {
        for (const cost of policy.costs) {
          const first = series.bars[0], last = series.bars[series.bars.length - 1];
          const available = first.bar.t === series.session.openAt
            && Date.parse(last.bar.t) + policy.coverage.intervalMs === Date.parse(series.session.closeAt)
            && first.availableAt <= series.session.closeAt && last.availableAt <= series.session.closeAt;
          if (!available) failures.push('baseline_unavailable');
          for (const [id, value] of [['cash-zero-interest', 0], ['session-buy-and-hold', available
            ? (last.bar.c / first.bar.o - 1) * 100 - 2 * costPct(cost) : null]] as const) {
            check(evaluations.length < policy.limits.evaluations, 'evaluation_budget');
            evaluations.push({ foldId: fold.id, phase: 'baseline', configurationId: id, scenarioId: cost.id,
              tradingDate: series.session.tradingDate, symbol: series.symbol, sourceCutoff: request.data.dataCutoff,
              readCutoff: series.session.closeAt, netReturnPct: value, trades: id === 'cash-zero-interest' ? 0 : value === null ? null : 1,
              reason: value === null ? 'baseline_unavailable' : null });
          }
        }
      }
      results.push({ fold, training, selectedConfigurationId: selected.id, status: failures.length ? 'rejected' : 'passed', reasons: unique(failures) });
    }
  } catch (error) { reasons.push(error instanceof Error ? error.message : 'evaluation_failed'); return finish('budget_exceeded'); }
  if (unique(evaluations.filter(e => e.phase === 'validation').map(e => e.tradingDate)).length < policy.minimum.independentValidationSessions)
    reasons.push('insufficient_independent_validation_sessions');
  return finish('complete');
}

/** Cooperatively bounded runner. A trusted kernel is synchronous and must itself remain bounded. */
export async function runChronological(request: ResearchRequest, simulate: ResearchSimulator,
  options: { signal?: AbortSignal; now?: () => number; yieldTask?: () => Promise<void> } = {}): Promise<ChronologicalReport> {
  const now = options.now ?? (() => performance.now()), started = now();
  const job = evaluateChronological(request, simulate), yieldTask = options.yieldTask ?? yieldToBrowser;
  let step = job.next();
  while (!step.done) {
    await yieldTask();
    const cancelled = options.signal?.aborted, elapsed = now() - started;
    if (cancelled || !Number.isFinite(elapsed) || elapsed < 0 || elapsed >= policy.limits.durationMs) {
      // Throw at the suspended evaluation so partial evidence and exposure survive interruption.
      step = job.throw(new Error(cancelled ? 'cancelled' : 'duration_budget'));
      if (!step.done) throw new Error('Research did not stop at its cooperative boundary');
      return structuredClone({ ...step.value, status: cancelled ? 'cancelled' : 'budget_exceeded', gates: 'failed', evidenceStatus: 'unavailable' });
    }
    step = job.next();
  }
  return step.value;
}
