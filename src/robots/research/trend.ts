import { FULL_SESSION_CALENDAR } from '../../core/exchange-session';
import { MOMENTUM_BACKTEST_ASSUMPTIONS, searchMomentum, type MomentumParameters, type MomentumSearchResult, type MomentumSearchStep } from '../math/momentum';
import type { Bar } from '../../core/types';
import { unavailableForecast } from './values';
import type { AccountScope } from '../../core/account';
import type { RobotSession, UnavailableForecast } from '../domain';
import { fullLegacySession, supportedTradingSession, sessionDate } from '../templates/common';
import { trendFollowing } from '../templates/trend-following';
import { identifier, instant, requireValue } from '../../core/validation';
import { validateScope } from '../validation';

/** Fixed resource/admission policy for experimental previews; never an execution permission. */
export const TREND_RESEARCH_POLICY = structuredClone({
  id: 'trend-legacy-experimental', version: 1, evidenceStatus: 'experimental',
  limits: { symbols: 4, concurrency: 2, historyDays: 7, historyPagesPerSymbol: 2, barsPerSymbol: 1200,
    parameterCandidatesPerSymbol: 66, setupsPerSymbol: 3, durationMs: 20_000, refreshMs: 300_000, snapshotMaxAgeMs: 60_000 },
  minimum: { sessions: 4, completedBarsPerSession: 48, trainingTrades: 3, heldOutTrades: 2, returnPctExclusive: 0 },
  selection: 'legacy-training-score-then-first-eligible-distinct-ema-pair',
  split: 'last-two-qualifying-sessions-held-out-disqualify-only',
  assumptions: { fees: 'Zero commissions assumed in simulation; actual fees unavailable.',
    spread: 'No separate spread model.', slippage: '2 basis points per side.',
    fills: 'Immediate full-notional simulated fills at the next observed five-minute opening price.',
    liquidation: '15:55 New York observed exit; residual inventory liquidated at final replay close.' },
  limitations: [MOMENTUM_BACKTEST_ASSUMPTIONS,
    'Experimental parameter selection on a current neutral shortlist; the symbol-selection pipeline is not validated.',
    'Parameters are fitted to regular-hours history. Extended and overnight execution performance has not been validated.',
    'Repeated reuse of the two-session holdout is not untouched or prospective validation; no robustness or calibration claim.'],
} as const);

export interface TrendResearchInput {
  readonly scope: AccountScope;
  readonly snapshotRef: string;
  readonly symbol: string;
  readonly dataCutoff: string;
  readonly session: RobotSession;
  readonly sessions: readonly RobotSession[];
  readonly bars: readonly Readonly<Bar>[];
}
export interface TrendCandidate {
  readonly schemaVersion: 1;
  readonly scope: AccountScope;
  readonly symbol: string;
  readonly template: typeof trendFollowing.identity;
  readonly direction: 'long';
  readonly sessionMode: 'regular' | '24x5';
  readonly supervision: 'browser';
  readonly parameters: Readonly<MomentumParameters>;
  readonly session: RobotSession;
  readonly entryWindow: { readonly from: string; readonly to: string };
  readonly intendedEnd: string;
  readonly executionPolicy: typeof trendFollowing.executionPolicy;
  readonly exitPolicy: typeof trendFollowing.exitPolicy;
  readonly dataCutoff: string;
  readonly researchPolicy: typeof TREND_RESEARCH_POLICY;
  readonly rationale: readonly string[];
  readonly evidence: { readonly status: 'experimental'; readonly ref: string; readonly snapshotRef: string;
    readonly testedCandidateCount: number; readonly assumptions: typeof TREND_RESEARCH_POLICY.assumptions;
    readonly limitations: readonly string[] };
  readonly forecast: UnavailableForecast;
}
export interface TrendEvaluation {
  readonly symbol: string;
  readonly status: 'selected' | 'rejected' | 'unavailable' | 'omitted';
  readonly reasonCode: string;
  readonly reason: string;
  readonly search: MomentumSearchResult | null;
  readonly candidate: TrendCandidate | null;
}
export const trendRejection = (symbol: string, status: Exclude<TrendEvaluation['status'], 'selected'>, reasonCode: string, reason: string): TrendEvaluation =>
  ({ symbol, status, reasonCode, reason, search: null, candidate: null });

/** Pure candidate generation. The scheduler drives each step only after a task yield.
 * No allocation, proposal publication, UI state, storage or broker surface is accepted.
 */
export function* researchTrend(input: TrendResearchInput): Generator<MomentumSearchStep, TrendEvaluation> {
  const limits = TREND_RESEARCH_POLICY.limits;
  try {
    validateScope(input.scope); instant(input.dataCutoff, 'cutoff'); identifier(input.snapshotRef, 'snapshotRef');
    requireValue(input.scope.broker === 'alpaca' && /^[A-Z][A-Z0-9.-]{0,14}$/.test(input.symbol)
      && supportedTradingSession(input.session) && input.session.openAt <= input.dataCutoff && input.dataCutoff < input.session.closeAt,
    'research', 'unsupported_context');
  } catch { return trendRejection(input.symbol, 'unavailable', 'invalid_research_input', 'A valid account scope, symbol, cutoff and supported trading session are required'); }
  const cutoff = Date.parse(input.dataCutoff);
  if (!Number.isFinite(cutoff) || !input.bars.length || input.bars.length > limits.barsPerSymbol) {
    return trendRejection(input.symbol, 'unavailable', 'history_size', 'History is missing or exceeds the fixed row budget');
  }
  if (!input.sessions.length || input.sessions.some(session => !(session.tradingDate === input.session.tradingDate ? supportedTradingSession(session) : fullLegacySession(session)) || session.calendarAsOf > input.dataCutoff)
    || new Set(input.sessions.map(session => session.tradingDate)).size !== input.sessions.length
    || input.bars.some(bar => !Number.isFinite(Date.parse(bar.t)) || !input.sessions.some(session => session.tradingDate === sessionDate(bar.t)))) {
    return trendRejection(input.symbol, 'unavailable', 'unsupported_history_sessions', 'Every history date needs authoritative full-session coverage; shortened sessions remain unsupported');
  }
  const search = searchMomentum(input.symbol, input.bars.map(bar => ({ ...bar })), cutoff);
  let step = search.next();
  while (!step.done) {
    try { trendFollowing.validateParameters(step.value.parameters); }
    catch { return trendRejection(input.symbol, 'unavailable', 'invalid_parameters', 'The legacy search produced parameters outside the declared template contract'); }
    if (step.value.phase === 'training' && step.value.testedCandidates >= limits.parameterCandidatesPerSymbol) {
      return trendRejection(input.symbol, 'unavailable', 'search_budget', 'Parameter search exceeded the fixed policy budget');
    }
    yield step.value;
    step = search.next();
  }
  const result = step.value;
  if (!result.report.setups.length) return { ...trendRejection(input.symbol, 'rejected', 'insufficient_history', result.report.warning), search: result };
  const setup = result.report.setups.find(value => value.eligible);
  if (!setup) return { ...trendRejection(input.symbol, 'rejected', 'all_parameters_rejected', result.report.warning), search: result };
  const end = Date.parse(input.session.closeAt);
  if (cutoff >= end - 15 * 60_000) return { ...trendRejection(input.symbol, 'rejected', 'entry_window_closed', 'The existing Trend entry window has closed'), search: result };
  return structuredClone({ symbol: input.symbol, status: 'selected', reasonCode: 'experimental_candidate',
    reason: 'The first training-ranked setup that passed the existing held-out disqualification checks', search: result,
    candidate: { schemaVersion: 1, scope: input.scope, symbol: input.symbol, template: trendFollowing.identity,
      direction: 'long', sessionMode: input.session.calendarId === FULL_SESSION_CALENDAR ? '24x5' : 'regular', supervision: 'browser', parameters: setup.parameters, session: input.session,
      entryWindow: { from: input.dataCutoff, to: new Date(end - 15 * 60_000).toISOString() }, intendedEnd: new Date(end - 5 * 60_000).toISOString(),
      executionPolicy: trendFollowing.executionPolicy, exitPolicy: trendFollowing.exitPolicy, dataCutoff: input.dataCutoff,
      researchPolicy: TREND_RESEARCH_POLICY,
      rationale: [setup.label, 'Selected using earlier-session simulation only; the final two qualifying sessions can disqualify, never rerank.',
        'At least three training trades and two held-out trades are required, with positive aggregate simulated return in each partition.'],
      evidence: { status: 'experimental', ref: `trend/${input.symbol}/${input.dataCutoff}`, snapshotRef: input.snapshotRef,
        testedCandidateCount: result.tested.length, assumptions: TREND_RESEARCH_POLICY.assumptions, limitations: TREND_RESEARCH_POLICY.limitations },
      forecast: unavailableForecast('Legacy Momentum simulations do not estimate activation-to-session-end P/L; no calibrated EOD estimator exists.'),
    } });
}
