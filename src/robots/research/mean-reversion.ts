import { FULL_SESSION_CALENDAR, tradingDate } from '../../core/exchange-session';
import { inspectSessionVwap, VWAP_DEFAULTS, VWAP_POLICY, vwapMeanReversion, type VwapParameters } from '../templates/vwap-mean-reversion';
import type { ChronologicalReport, ResearchSimulator } from './chronological';
import { CHRONOLOGICAL_RESEARCH_POLICY } from './policy';
import type { TrendCandidate } from './trend';
import type { UniverseSnapshot } from './universe';
import { unavailableForecast } from './values';
import type { WickEvaluation, WickResearchBatch } from './wick';

export const MEAN_REVERSION_POLICY = structuredClone({
  id: 'vwap-chronological-experimental', version: 1,
  limits: { symbols: 2, sessions: 20, configurations: 3, barsPerSymbol: 1560, historyRequests: 2, durationMs: 20_000 },
  configurations: [0.5, 0.55, 0.6].map((entryDeviationPct, index) => ({ id: `vwap-${index + 1}`,
    parameters: { ...VWAP_DEFAULTS, entryDeviationPct }, neighbors: [1, 2, 3].filter(n => n !== index + 1).map(n => `vwap-${n}`) })),
  assumptions: { fees: '1 bp per side; stress 2 bps.', spread: '2 bps per side; stress 5 bps.',
    slippage: '2 bps per side; stress 8 bps.', fills: 'Next completed-bar close; stress second subsequent close. No intrabar fills or queue model.',
    liquidation: 'Observed mean, stop, actual simulated holding deadline or five-minute session buffer; unfilled exits remain unavailable.' },
  limitations: [...CHRONOLOGICAL_RESEARCH_POLICY.limitations,
    'Regular-hours training does not validate extended or overnight execution performance.',
    'Conditional on two current neutral symbols and retrospective calendar bounds; no point-in-time universe or calendar claim.',
    'Holdout exposure is tracked in this local account journal only. Clearing storage or research elsewhere cannot establish global untouched history.',
    'Historical arrival timestamps are unavailable: retrospective simulation assumes each observed bar becomes readable at its close. HLC3 bar-volume VWAP and delayed closing-price fills approximate observations; they are not broker executions.',
    'Three fixed neighboring entry thresholds; all other settings fixed. Two chronological folds must pass without validation reranking.',
    'Historical simulation cannot qualify an execution forecast for a new family; its own prospective outcomes and calibration are required.'],
});
export interface MeanReversionCandidate extends Omit<TrendCandidate, 'parameters' | 'researchPolicy' | 'evidence'> {
  readonly parameters: Readonly<VwapParameters>;
  readonly researchPolicy: typeof MEAN_REVERSION_POLICY;
  readonly evidence: Omit<TrendCandidate['evidence'], 'assumptions'> & { readonly assumptions: typeof MEAN_REVERSION_POLICY.assumptions };
}
export interface MeanReversionBatch extends Omit<WickResearchBatch, 'policy' | 'evaluations'> {
  readonly policy: typeof MEAN_REVERSION_POLICY;
  readonly evaluations: readonly (Omit<WickEvaluation, 'candidate'> & { readonly candidate: MeanReversionCandidate | null })[];
}

/** Observation-by-observation kernel. A signal cannot fill at its own bar price. */
export const simulateMeanReversion: ResearchSimulator = (configuration, reader, cost) => {
  vwapMeanReversion.validateParameters(configuration.parameters);
  const p = configuration.parameters as VwapParameters, interval = VWAP_POLICY.intervalMs;
  const open = Date.parse(reader.session.openAt), close = Date.parse(reader.session.closeAt);
  let entry: { price: number; at: number } | null = null, pending: { side: 'buy' | 'sell'; at: number } | null = null;
  let grossReturnPct = 0, trades = 0;
  for (let at = open + interval; at <= close; at += interval) {
    const time = new Date(at).toISOString(), bars = reader.bars(time), latest = bars.at(-1);
    if (!latest || Date.parse(latest.t) + interval !== at) return { unavailable: 'incomplete_session_history' };
    const inspection = inspectSessionVwap(bars, reader.session, time);
    if (inspection.status !== 'available') return { unavailable: inspection.reason };
    if (pending && pending.at === at) {
      if (pending.side === 'buy') entry = { price: latest.c, at };
      else { grossReturnPct += (latest.c / entry!.price - 1) * 100; trades++; entry = null; }
      pending = null;
      continue; // No sell/re-entry at the same observation as a simulated fill.
    }
    if (pending) continue;
    const s = inspection.statistics;
    if (entry) {
      if (latest.c >= s.vwap || latest.c <= entry.price * (1 - p.stopLossPct / 100)
        || at - entry.at >= p.holdMinutes * 60_000 || close - at <= VWAP_POLICY.exitBufferMinutes * 60_000)
        pending = { side: 'sell', at: at + interval * cost.observationDelay };
    } else {
      const deviation = (1 - latest.c / s.vwap) * 100;
      if (close - at > VWAP_POLICY.exitBufferMinutes * 60_000 && s.count >= p.warmupBars
        && deviation >= p.entryDeviationPct && deviation <= VWAP_POLICY.maximumDeviationPct
        && s.trendPct <= p.maxTrendPct && s.volatilityPct >= VWAP_POLICY.minimumVolatilityPct
        && s.volatilityPct <= p.maxVolatilityPct && s.sessionDollars >= p.minSessionDollarVolume
        && cost.spreadBpsPerSide * 2 / 100 <= VWAP_POLICY.maximumSpreadPct)
        pending = { side: 'buy', at: at + interval * cost.observationDelay };
    }
  }
  if (entry || pending) return { unavailable: 'unobserved_session_liquidation' };
  return { grossReturnPct, turnover: trades * 2, trades, fillModel: cost.id };
};

/** Last fold's TRAINING winner is fixed. Per-symbol checks can only disqualify it. */
export function meanReversionBatch(snapshot: UniverseSnapshot, at: string, report: ChronologicalReport | null,
  evidenceRef: string | null, historyRequests: number, reason = 'Chronological evidence unavailable.'): MeanReversionBatch {
  const selected = report?.configurations.find(c => c.id === report.folds.at(-1)?.selectedConfigurationId);
  const evaluations: MeanReversionBatch['evaluations'] = snapshot.candidates.map((row, index) => {
    const reject = (status: 'unavailable' | 'rejected' | 'omitted', reasonCode: string, detail: string) =>
      ({ symbol: row.asset.symbol, status, reasonCode, reason: detail, candidate: null });
    if (index >= MEAN_REVERSION_POLICY.limits.symbols) return reject('omitted', 'symbol_budget', 'Outside the fixed neutral symbol budget.');
    const blocks = vwapMeanReversion.discoveryEligibility({ session: snapshot.session, dataCutoff: snapshot.dataCutoff,
      capabilities: snapshot.data.capabilities, quote: row.quote });
    if (blocks.length) return reject('unavailable', blocks[0].code, blocks[0].reason);
    if (!report || report.gates !== 'passed' || !selected || !evidenceRef || tradingDate(Date.parse(report.data.asOf)) !== snapshot.session.tradingDate) return reject('unavailable', 'chronological_gates_failed',
      report ? [...report.reasons, ...report.folds.flatMap(f => f.reasons)].join('; ') || reason : reason);
    const validation = report.evaluations.filter(e => e.symbol === row.asset.symbol && ['validation', 'stress', 'neighbor'].includes(e.phase));
    if (!validation.length || validation.some(e => e.reason || e.netReturnPct === null || e.netReturnPct <= 0 || !e.trades))
      return reject('rejected', 'symbol_robustness_failed', 'The fixed winner lacks positive, complete per-session symbol evidence under every stress and neighbor check.');
    const end = Date.parse(snapshot.session.closeAt), entryEnd = end - VWAP_POLICY.exitBufferMinutes * 60_000;
    if (Date.parse(at) >= entryEnd - 60_000) return reject('rejected', 'entry_window_closed', 'The session entry window has closed.');
    const parameters = selected.parameters as VwapParameters;
    return { symbol: row.asset.symbol, status: 'selected', reasonCode: 'chronological_experimental_candidate',
      reason: 'Bounded chronological gates passed; experimental simulation evidence only.', candidate: {
        schemaVersion: 1, scope: snapshot.scope, symbol: row.asset.symbol, template: vwapMeanReversion.identity,
        direction: 'long', sessionMode: snapshot.session.calendarId === FULL_SESSION_CALENDAR ? '24x5' : 'regular', supervision: 'browser', parameters, session: snapshot.session,
        entryWindow: { from: snapshot.dataCutoff, to: new Date(entryEnd - 60_000).toISOString() }, intendedEnd: new Date(entryEnd).toISOString(),
        executionPolicy: vwapMeanReversion.executionPolicy, exitPolicy: vwapMeanReversion.exitPolicy,
        dataCutoff: snapshot.dataCutoff, researchPolicy: MEAN_REVERSION_POLICY,
        rationale: [`Observe a ${parameters.entryDeviationPct}% deviation below session VWAP with bounded trend, volatility, spread and liquidity filters.`,
          `Retained research ${report.data.asOf}: ${report.breadth.independentValidationSessions} independent validation sessions; training winner ${selected.id}.`,
          'Mean, observed stop, first-fill holding deadline and approved-session exits use the shared owned-inventory runner.'],
        evidence: { status: 'experimental', ref: evidenceRef, snapshotRef: snapshot.id, testedCandidateCount: report.breadth.testedConfigurations,
          assumptions: MEAN_REVERSION_POLICY.assumptions, limitations: MEAN_REVERSION_POLICY.limitations },
        forecast: unavailableForecast('This strategy family lacks its own qualifying prospective execution outcomes and calibration.') } };
  });
  return structuredClone({ schemaVersion: 1, scope: snapshot.scope, connectionGeneration: snapshot.connectionGeneration,
    snapshotRef: snapshot.id, generatedAt: at, dataCutoff: snapshot.dataCutoff, policy: MEAN_REVERSION_POLICY, universeBreadth: snapshot.breadth,
    evaluations, counts: { inputSymbols: snapshot.candidates.length, researchedSymbols: Math.min(snapshot.candidates.length, MEAN_REVERSION_POLICY.limits.symbols),
      selectedSymbols: evaluations.filter(e => e.status === 'selected').length, testedCandidates: report?.breadth.testedConfigurations ?? 0, historyRequests } });
}
