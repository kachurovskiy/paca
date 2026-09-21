import { FULL_SESSION_CALENDAR } from '../../core/exchange-session';
import { unavailableForecast } from './values';
import { wickCapture } from '../templates/wick-capture';
import { instant, requireValue } from '../../core/validation';
import { validateScope } from '../validation';
import type { TrendCandidate } from './trend';
import { UNIVERSE_LIMITS, validateUniverseContext, type UniverseSnapshot } from './universe';

/** Observational engineering policy, not a return-ranked search or a fill simulator. */
export const WICK_RESEARCH_POLICY = structuredClone({
  id: 'wick-observed-experimental', version: 1, evidenceStatus: 'experimental', provenance: 'shadow',
  limits: { symbols: 4, parameterCandidatesPerSymbol: 3, snapshotMaxAgeMs: 60_000, maximumSpreadPct: 0.5 },
  settings: [{ dipPct: 0.5, holdMinutes: 5 }, { dipPct: 1, holdMinutes: 10 }, { dipPct: 2, holdMinutes: 15 }],
  selection: 'neutral-liquidity-order; first-fixed-dip-at-least-three-observed-spreads',
  assumptions: { fees: 'Unavailable; no return calculation.', spread: 'Current observed bid/ask only.',
    slippage: 'Unavailable.', fills: 'No simulated fills; bars cannot establish queue position or first-fill timing.',
    liquidation: 'Owned-only market exit after first-fill deadline or session cutoff, subject to broker availability.' },
  limitations: ['Experimental observation-only settings selection; no profitability, validation or fill-probability claim.',
    'Three fixed dip/holding pairs bound selection. Three observed spreads is an engineering separation rule, not an estimated edge.',
    'A resting bid may never fill; partial fills and adverse selection can lose money. Fees and exit slippage are unavailable.',
    'Holding time begins with the earliest attributable actual fill. Browser suspension can prevent timely cancellation or exit.'],
} as const);

export interface WickCandidate extends Omit<TrendCandidate, 'template' | 'parameters' | 'researchPolicy' | 'evidence'> {
  readonly template: typeof wickCapture.identity;
  readonly parameters: { readonly dipPct: number; readonly holdMinutes: number };
  readonly researchPolicy: typeof WICK_RESEARCH_POLICY;
  readonly evidence: Omit<TrendCandidate['evidence'], 'assumptions'> & { readonly assumptions: typeof WICK_RESEARCH_POLICY.assumptions };
}
export interface WickEvaluation {
  readonly symbol: string;
  readonly status: 'selected' | 'rejected' | 'unavailable' | 'omitted';
  readonly reasonCode: string;
  readonly reason: string;
  readonly candidate: WickCandidate | null;
}
export interface WickResearchBatch {
  readonly schemaVersion: 1;
  readonly scope: UniverseSnapshot['scope'];
  readonly connectionGeneration: number;
  readonly snapshotRef: string;
  readonly generatedAt: string;
  readonly dataCutoff: string;
  readonly policy: typeof WICK_RESEARCH_POLICY;
  readonly universeBreadth: UniverseSnapshot['breadth'];
  readonly evaluations: readonly WickEvaluation[];
  readonly counts: { readonly inputSymbols: number; readonly researchedSymbols: number; readonly selectedSymbols: number;
    readonly testedCandidates: number; readonly historyRequests: number };
}

/** At most 4 x 3 cheap settings checks on a detached neutral snapshot; no I/O,
 * historical/trend qualification, optimizer, fill inference or return forecast. */
export function researchWick(snapshot: UniverseSnapshot, at: string): WickResearchBatch {
  instant(at, 'wick.now'); validateScope(snapshot.scope);
  validateUniverseContext({ scope: snapshot.scope, connectionGeneration: snapshot.connectionGeneration,
    tradingDate: snapshot.session.tradingDate, data: snapshot.data });
  requireValue(snapshot.schemaVersion === 1 && snapshot.scope.broker === 'alpaca' && snapshot.asOf === snapshot.dataCutoff
    && snapshot.dataCutoff <= at && Date.parse(at) - Date.parse(snapshot.dataCutoff) <= WICK_RESEARCH_POLICY.limits.snapshotMaxAgeMs
    && snapshot.data.status === 'available' && (snapshot.data.feed === 'sip' || snapshot.data.feed === 'boats') && snapshot.data.asOf <= at && at < snapshot.data.validUntil
    && snapshot.candidates.length <= UNIVERSE_LIMITS.candidates
    && new Set(snapshot.candidates.map(row => row.asset.symbol)).size === snapshot.candidates.length, 'wick', 'snapshot_unavailable');
  let tested = 0;
  const evaluations: WickEvaluation[] = snapshot.candidates.map((row, index) => {
    const reject = (status: Exclude<WickEvaluation['status'], 'selected'>, reasonCode: string, reason: string): WickEvaluation =>
      ({ symbol: row.asset.symbol, status, reasonCode, reason, candidate: null });
    if (index >= WICK_RESEARCH_POLICY.limits.symbols) return reject('omitted', 'symbol_budget', 'Outside the fixed neutral shortlist budget.');
    const blocks = wickCapture.discoveryEligibility({ session: snapshot.session, dataCutoff: snapshot.dataCutoff,
      capabilities: snapshot.data.capabilities, quote: row.quote });
    if (blocks.length) return reject('unavailable', blocks[0].code, blocks.map(block => block.reason).join(' '));
    const spread = (row.quote!.ask! / row.quote!.bid! - 1) * 100;
    if (!Number.isFinite(spread) || spread < 0 || spread > WICK_RESEARCH_POLICY.limits.maximumSpreadPct)
      return reject('rejected', 'wick_spread_limit', 'Observed spread exceeds this experimental policy; no fill or return inference is made.');
    const checked = WICK_RESEARCH_POLICY.settings.map(parameters => { tested++; return { parameters, eligible: parameters.dipPct >= spread * 3 }; });
    const parameters = checked.find(value => value.eligible)?.parameters;
    if (!parameters) return reject('rejected', 'wick_settings_unavailable', 'No fixed settings meet the observed-spread rule.');
    wickCapture.validateParameters(parameters);
    const end = Date.parse(snapshot.session.closeAt), entryEnd = end - Math.max(parameters.holdMinutes + 1, 5) * 60_000;
    if (Date.parse(at) >= entryEnd) return reject('rejected', 'entry_window_closed', 'Insufficient session time for this holding policy.');
    return { symbol: row.asset.symbol, status: 'selected', reasonCode: 'experimental_observation_candidate',
      reason: 'Fixed Wick settings selected from a neutral quote; no backtest qualification.',
      candidate: { schemaVersion: 1, scope: snapshot.scope, symbol: row.asset.symbol, template: wickCapture.identity,
        direction: 'long', sessionMode: snapshot.session.calendarId === FULL_SESSION_CALENDAR ? '24x5' : 'regular', supervision: 'browser', parameters, session: snapshot.session,
        entryWindow: { from: snapshot.dataCutoff, to: new Date(entryEnd).toISOString() }, intendedEnd: new Date(end - 60_000).toISOString(),
        executionPolicy: wickCapture.executionPolicy, exitPolicy: wickCapture.exitPolicy, dataCutoff: snapshot.dataCutoff,
        researchPolicy: WICK_RESEARCH_POLICY,
        rationale: [`Rest a whole-share limit bid ${parameters.dipPct}% below the observed bid; hold ${parameters.holdMinutes} minutes from the first actual fill.`,
          `Observed spread ${spread}%; selection rule: ${WICK_RESEARCH_POLICY.selection}.`,
          'Cancel before replacement; partial-fill residuals must be canceled and reconciled before an owned-only exit.'],
        evidence: { status: 'experimental', ref: `wick/${row.asset.symbol}/${snapshot.dataCutoff}`, snapshotRef: snapshot.id,
          testedCandidateCount: checked.length, assumptions: WICK_RESEARCH_POLICY.assumptions, limitations: WICK_RESEARCH_POLICY.limitations },
        forecast: unavailableForecast('No Wick fill model or calibrated activation-to-session-end estimator exists.') } };
  });
  return structuredClone({ schemaVersion: 1, scope: snapshot.scope, connectionGeneration: snapshot.connectionGeneration,
    snapshotRef: snapshot.id, generatedAt: at, dataCutoff: snapshot.dataCutoff, policy: WICK_RESEARCH_POLICY, universeBreadth: snapshot.breadth,
    evaluations, counts: { inputSymbols: snapshot.candidates.length, researchedSymbols: Math.min(snapshot.candidates.length, WICK_RESEARCH_POLICY.limits.symbols),
      selectedSymbols: evaluations.filter(row => row.status === 'selected').length, testedCandidates: tested, historyRequests: 0 } });
}
