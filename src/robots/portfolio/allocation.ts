import { MEAN_REVERSION_POLICY, type MeanReversionBatch, type MeanReversionCandidate } from '../research/mean-reversion';
import { canonicalSerialize } from '../research/values';
import { decimal, numberDecimal, product, units } from '../../core/decimal';
import type { ExactPercentage } from '../../portfolio/accounting';
import type { AccountScope } from '../../core/account';
import type { VersionedIdentity, Veto } from '../domain';
import { quantityWithinBudget, validateQuantity } from '../../core/precision';
import type { ProposalDraft } from '../research/proposals';
import type { TrendResearchBatch } from '../research/scheduler';
import type { TrendCandidate } from '../research/trend';
import { TREND_RESEARCH_POLICY } from '../research/trend';
import { WICK_RESEARCH_POLICY, type WickCandidate, type WickResearchBatch } from '../research/wick';
import { templatePolicy } from './template-policy';
import { identifier, instant, integer, requireValue } from '../../core/validation';
import { sameScope, validateScope } from '../validation';
import { validateSession } from '../plan';
import { cents, money, normalizePortfolio, portfolioBlock, type PortfolioInput, type PortfolioSnapshot } from './snapshot';

export interface AllocationPolicy extends VersionedIdentity {
  readonly accountCapitalBudgetBps: number;
  readonly perRunCapBps: number;
  readonly symbolConcentrationBps: number;
  readonly aggregateExposureBps: number;
  readonly perRunRiskBudgetBps: number;
  readonly aggregateStressBudgetBps: number;
  /** Explicit stress scenario for existing exposure; never an estimated loss probability. */
  readonly existingExposureStressBps: number;
  readonly minimumCandidateStressBps: number;
  readonly lossTriggerBps: number;
  readonly dailyLiquidityParticipationBps: number;
  readonly entryPriceBufferBps: number;
  readonly quantityIncrement: number;
  readonly minimumAllocationCents: number;
  readonly maxProposals: number;
  readonly snapshotMaxAgeMs: number;
  readonly researchMaxAgeMs: number;
  readonly proposalTtlMs: number;
  readonly rationale: string;
}

/** Engineering preview limits, not calibrated safety estimates or execution admission. */
export const ALLOCATION_POLICY: AllocationPolicy = structuredClone({
  id: 'conservative-paper-allocation', version: 2,
  accountCapitalBudgetBps: 10_000, perRunCapBps: 1000,
  symbolConcentrationBps: 2000, aggregateExposureBps: 8000,
  perRunRiskBudgetBps: 200, aggregateStressBudgetBps: 2000,
  existingExposureStressBps: 10_000, minimumCandidateStressBps: 2000, lossTriggerBps: 500,
  dailyLiquidityParticipationBps: 10, entryPriceBufferBps: 100, quantityIncrement: 0.001,
  minimumAllocationCents: 100, maxProposals: 3, snapshotMaxAgeMs: 30_000,
  researchMaxAgeMs: 300_000, proposalTtlMs: 30_000,
  rationale: 'Preview policy: target 10% of account equity per run, with 20% per symbol and 80% aggregate equity limits. '
    + 'Available cash and buying power after commitments cap the batch; leveraged buying power never increases the equity-based target. '
    + 'Existing commitments use a full-capital stress bound; new candidates require at least a 20% stress scenario. '
    + '2% of equity per run and 20% of equity aggregate are stress-sizing allowances, not loss guarantees. '
    + 'A 5% loss trigger requests action without guaranteeing its price or timing. '
    + '0.1% of complete prior-session mean dollar volume limits size, not market impact. '
    + 'A 1% observed-price buffer and 0.001-share floor reduce preview rounding/price risk. '
    + 'Three distinct symbols bound the batch; this is symbol diversification only. '
    + '30-second observations/proposals and five-minute research retention are engineering freshness limits, not measured safety.',
});

export interface CandidateSizing {
  readonly scope: AccountScope;
  readonly symbol: string;
  readonly sourceRef: string;
  readonly asOf: string;
  readonly validUntil: string;
  readonly priceUsd: number | null;
  readonly averageDailyDollarVolumeUsd: number | null;
  readonly liquidityComplete: boolean;
  /** Caller-supplied scenario with a source/rationale, not inferred from a stop. */
  readonly stressedLossBps: number | null;
  readonly stressRationale: string | null;
}
export interface AllocationInput {
  readonly evaluatedAt: string;
  readonly portfolio: PortfolioInput;
  readonly research: TrendResearchBatch | WickResearchBatch | MeanReversionBatch;
  readonly alternatives?: readonly (TrendResearchBatch | WickResearchBatch | MeanReversionBatch)[];
  readonly sizing: readonly CandidateSizing[];
}
export interface CandidateAllocation {
  readonly symbol: string;
  readonly status: 'allocated' | 'blocked';
  readonly blocks: readonly Veto[];
  readonly capitalCents: number | null;
  readonly quantity: number | null;
  readonly bufferedPriceUsd: string | null;
  readonly allocationOnSnapshotEquityPct: ExactPercentage | null;
  readonly riskBudgetCents: number | null;
  readonly lossTriggerCents: number | null;
  readonly constraints: Readonly<Record<string, number>> | null;
}
export interface AllocationBatch {
  readonly schemaVersion: 1;
  readonly scope: AccountScope;
  readonly evaluatedAt: string;
  readonly policy: AllocationPolicy;
  readonly portfolio: PortfolioSnapshot;
  readonly researchSnapshotRef: string;
  readonly blocks: readonly Veto[];
  readonly candidates: readonly CandidateAllocation[];
  readonly drafts: readonly ProposalDraft[];
}

const ratio = (amount: number, bps: number, up = false): number => {
  const numerator = BigInt(amount) * BigInt(bps);
  return Number((numerator + (up ? 9999n : 0n)) / 10000n);
};
const usd = (cents: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
function validatePolicy(policy: AllocationPolicy): void {
  identifier(policy.id, 'policy.id'); integer(policy.version, 'policy.version');
  for (const key of ['minimumAllocationCents', 'snapshotMaxAgeMs', 'researchMaxAgeMs', 'proposalTtlMs', 'maxProposals'] as const) integer(policy[key], key);
  for (const key of ['accountCapitalBudgetBps', 'perRunCapBps', 'perRunRiskBudgetBps', 'aggregateStressBudgetBps',
    'symbolConcentrationBps', 'aggregateExposureBps', 'existingExposureStressBps', 'minimumCandidateStressBps',
    'lossTriggerBps', 'dailyLiquidityParticipationBps'] as const) {
    integer(policy[key], key); requireValue(policy[key] <= 10000, key, 'invalid_basis_points');
  }
  integer(policy.entryPriceBufferBps, 'entryPriceBufferBps', 0);
  requireValue(policy.entryPriceBufferBps <= 10000 && policy.maxProposals <= 3, 'policy', 'resource_limit');
  validateQuantity(policy.quantityIncrement);
  requireValue(typeof policy.rationale === 'string' && policy.rationale.trim().length > 0, 'policy', 'missing_rationale');
  // The shipped identity names an exact immutable configuration. Custom tuning
  // must have its own version/identity and retains its complete values in evidence.
  if (policy.id === ALLOCATION_POLICY.id && policy.version === ALLOCATION_POLICY.version) {
    requireValue(canonicalSerialize(policy) === canonicalSerialize(ALLOCATION_POLICY), 'policy', 'version_configuration_mismatch');
  }
}
function current(asOf: string, validUntil: string, now: string, maxAge: number): boolean {
  instant(asOf, 'asOf'); instant(validUntil, 'validUntil');
  return asOf <= now && now < validUntil && Date.parse(now) - Date.parse(asOf) <= maxAge;
}
function candidateValid(candidate: TrendCandidate | WickCandidate | MeanReversionCandidate, input: AllocationInput, batch: AllocationInput['research']): void {
  const at = input.evaluatedAt, admitted = templatePolicy(candidate.template), template = admitted.template;
  validateScope(candidate.scope); validateSession(candidate.session); instant(candidate.dataCutoff, 'dataCutoff');
  instant(candidate.entryWindow.from, 'entryWindow.from'); instant(candidate.entryWindow.to, 'entryWindow.to'); instant(candidate.intendedEnd, 'intendedEnd');
  requireValue(candidate.schemaVersion === 1 && sameScope(candidate.scope, input.portfolio.scope)
    && candidate.direction === 'long' && ['regular', '24x5'].includes(candidate.sessionMode) && candidate.supervision === 'browser'
    && canonicalSerialize(candidate.researchPolicy) === canonicalSerialize(admitted.research)
    && canonicalSerialize(candidate.researchPolicy) === canonicalSerialize(batch.policy)
    && canonicalSerialize(candidate.executionPolicy) === canonicalSerialize(template.executionPolicy)
    && canonicalSerialize(candidate.exitPolicy) === canonicalSerialize(template.exitPolicy), 'candidate', 'unsupported_candidate');
  requireValue(candidate.dataCutoff === batch.dataCutoff && candidate.evidence.snapshotRef === batch.snapshotRef
    && candidate.evidence.status === 'experimental' && candidate.forecast.status === 'unavailable', 'candidate', 'evidence_mismatch');
  identifier(candidate.evidence.ref, 'evidence.ref'); template.validateParameters(candidate.parameters);
  if (template.identity.id === 'wick-capture') requireValue(WICK_RESEARCH_POLICY.settings.some(setting =>
    canonicalSerialize(setting) === canonicalSerialize(candidate.parameters)), 'candidate', 'wick_settings_not_admitted');
  requireValue(candidate.session.calendarAsOf <= at && candidate.session.openAt <= candidate.entryWindow.from
    && candidate.entryWindow.from <= at && at < candidate.entryWindow.to && candidate.entryWindow.to <= candidate.intendedEnd
    && candidate.intendedEnd <= candidate.session.closeAt, 'candidate', 'entry_window_closed');
}

/** Deterministic allocation on supplied observations. No broker, storage or UI
 * dependencies. Batch headroom is simulated locally; pending proposals reserve nothing. */
export function allocatePortfolio(input: AllocationInput, policy: AllocationPolicy = ALLOCATION_POLICY): AllocationBatch {
  validatePolicy(policy); instant(input.evaluatedAt, 'evaluatedAt');
  const portfolio = normalizePortfolio(input.portfolio), at = input.evaluatedAt, research = input.research;
  const blocks: Veto[] = [...portfolio.blocks];
  if (!current(portfolio.asOf, portfolio.validUntil, at, policy.snapshotMaxAgeMs)) {
    blocks.push(portfolioBlock('stale_portfolio', 'A current, non-future complete portfolio snapshot is required.'));
  }
  const batches = [research, ...(input.alternatives ?? [])];
  try {
    requireValue(batches.length <= 3 && new Set(batches.map(batch => batch.policy.id)).size === batches.length, 'research', 'duplicate_policy');
    for (const research of batches) {
      instant(research.dataCutoff, 'research.dataCutoff'); instant(research.generatedAt, 'research.generatedAt');
      identifier(research.snapshotRef, 'research.snapshotRef');
      requireValue(research.schemaVersion === 1 && sameScope(research.scope, portfolio.scope)
        && research.dataCutoff <= research.generatedAt && research.generatedAt <= at
        && Date.parse(at) - Date.parse(research.dataCutoff) <= policy.researchMaxAgeMs
        && [TREND_RESEARCH_POLICY, WICK_RESEARCH_POLICY, MEAN_REVERSION_POLICY].some(policy => canonicalSerialize(research.policy) === canonicalSerialize(policy))
        && research.evaluations.length <= 30 && research.evaluations.filter(row => row.candidate !== null).length <= 4,
      'research', 'invalid_research_batch');
    }
  } catch { blocks.push(portfolioBlock('research_unavailable', 'Current matching bounded experimental research is required.')); }
  const candidates: CandidateAllocation[] = [], drafts: ProposalDraft[] = [];
  const selected = batches.flatMap(batch => batch.evaluations.filter(row => row.status === 'selected' && row.candidate !== null).map(row => ({ ...row, batch })));
  const eligible: { candidate: TrendCandidate | WickCandidate | MeanReversionCandidate; sizing: CandidateSizing; batch: AllocationInput['research'] }[] = [];
  const rejected = (symbol: string, vetoes: readonly Veto[]) => candidates.push({ symbol, status: 'blocked', blocks: vetoes,
    capitalCents: null, quantity: null, bufferedPriceUsd: null, allocationOnSnapshotEquityPct: null,
    riskBudgetCents: null, lossTriggerCents: null, constraints: null });
  for (const row of selected) {
    const candidate = row.candidate!, vetoes: Veto[] = [...blocks];
    const matches = input.sizing.filter(sizing => sizing.symbol === candidate.symbol);
    const sizing = matches[0];
    try {
      candidateValid(candidate, input, row.batch);
      requireValue(row.symbol === candidate.symbol && selected.filter(value => value.symbol === row.symbol && value.batch.policy.id === row.batch.policy.id).length === 1,
        'candidate', 'duplicate_or_mismatched_symbol');
      requireValue(matches.length === 1 && sameScope(sizing.scope, portfolio.scope), 'sizing', 'sizing_scope_mismatch');
      identifier(sizing.sourceRef, 'sizing.sourceRef');
      requireValue(current(sizing.asOf, sizing.validUntil, at, policy.snapshotMaxAgeMs), 'sizing', 'stale_sizing');
      requireValue(sizing.priceUsd !== null && sizing.priceUsd > 0 && sizing.averageDailyDollarVolumeUsd !== null
        && sizing.averageDailyDollarVolumeUsd > 0 && sizing.liquidityComplete === true, 'sizing', 'price_or_liquidity_unavailable');
      money(sizing.priceUsd); money(sizing.averageDailyDollarVolumeUsd);
      integer(sizing.stressedLossBps, 'stressedLossBps');
      requireValue(sizing.stressedLossBps! >= policy.minimumCandidateStressBps && sizing.stressedLossBps! <= 10000
        && typeof sizing.stressRationale === 'string' && sizing.stressRationale.trim().length > 0, 'sizing', 'risk_unavailable');
    } catch (error) { vetoes.push(portfolioBlock('candidate_inputs_unavailable', `Candidate inputs are unavailable: ${error instanceof Error ? error.message : 'invalid input'}`)); }
    if (portfolio.symbolClaims.includes(row.symbol)) vetoes.push(portfolioBlock('symbol_conflict', 'Existing manual or robot holdings, orders or active commitments claim this symbol.'));
    if (vetoes.length) rejected(row.symbol, vetoes); else eligible.push({ candidate, sizing, batch: row.batch });
  }
  // Liquidity is a capacity ranking, never a return forecast or success probability.
  eligible.sort((a, b) => b.sizing.averageDailyDollarVolumeUsd! - a.sizing.averageDailyDollarVolumeUsd!
    || (a.candidate.symbol < b.candidate.symbol ? -1 : a.candidate.symbol > b.candidate.symbol ? 1 : 0)
    || a.candidate.template.id.localeCompare(b.candidate.template.id));
  const equity = portfolio.equityCents ?? 0, exposure = portfolio.totals?.aggregateExposureCents ?? 0;
  const accountBudget = ratio(equity, policy.accountCapitalBudgetBps), perRunCap = ratio(equity, policy.perRunCapBps);
  const perRunRiskBudget = ratio(equity, policy.perRunRiskBudgetBps), aggregateStressBudget = ratio(equity, policy.aggregateStressBudgetBps);
  let capitalHeadroom = Math.max(0, accountBudget - exposure);
  let aggregateHeadroom = Math.max(0, ratio(equity, policy.aggregateExposureBps) - exposure);
  let buyingPower = portfolio.totals?.availableBuyingPowerCents ?? 0;
  let stressHeadroom = Math.max(0, aggregateStressBudget - ratio(exposure, policy.existingExposureStressBps, true));
  for (const { candidate, sizing, batch } of eligible) {
    if (drafts.some(draft => draft.symbol === candidate.symbol)) {
      rejected(candidate.symbol, [portfolioBlock('symbol_competition', 'Another template won the deterministic shared allocation for this symbol; no concurrent symbol claim is allowed.')]); continue;
    }
    if (drafts.length >= policy.maxProposals) {
      rejected(candidate.symbol, [portfolioBlock('batch_limit', 'The bounded distinct-symbol proposal batch is full.')]); continue;
    }
    const stress = sizing.stressedLossBps!;
    const riskLimit = BigInt(Math.min(perRunRiskBudget, stressHeadroom)) * 10000n / BigInt(stress);
    const riskCap = Number(riskLimit > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : riskLimit);
    const constraints = { accountBudget: capitalHeadroom, aggregateExposure: aggregateHeadroom,
      buyingPower, perRun: perRunCap, symbolConcentration: ratio(equity, policy.symbolConcentrationBps),
      liquidity: cents(money(sizing.averageDailyDollarVolumeUsd!) * BigInt(policy.dailyLiquidityParticipationBps) / 10000n, 'down'),
      stressedLoss: riskCap };
    const capital = Math.min(...Object.values(constraints));
    const labels = { accountBudget: `Account capital budget: ${usd(capitalHeadroom)} remaining of ${usd(accountBudget)}; existing exposure ${usd(exposure)}`,
      stressedLoss: `Stress budget: ${usd(stressHeadroom)} remaining of ${usd(aggregateStressBudget)}; existing exposure stress ${usd(ratio(exposure, policy.existingExposureStressBps, true))}; per-run allowance ${usd(perRunRiskBudget)}`,
      aggregateExposure: `Aggregate equity exposure allowance: ${usd(aggregateHeadroom)} remaining`,
      buyingPower: `Available cash and buying power: ${usd(buyingPower)}`, perRun: `Per-run capital limit: ${usd(perRunCap)}`,
      symbolConcentration: `Per-symbol equity limit: ${usd(constraints.symbolConcentration)}`, liquidity: `Liquidity allowance: ${usd(constraints.liquidity)}` };
    const binding = (Object.keys(constraints) as (keyof typeof constraints)[]).filter(key => constraints[key] === capital).map(key => labels[key]).join('. ');
    if (capital < policy.minimumAllocationCents) {
      rejected(candidate.symbol, [portfolioBlock('insufficient_capacity', `Available allocation ${usd(capital)} is below the ${usd(policy.minimumAllocationCents)} minimum. ${binding}.`)]); continue;
    }
    const price = money(sizing.priceUsd!) * BigInt(10000 + policy.entryPriceBufferBps) / 10000n;
    // Preserve twelve-place prices by rounding the buffered sizing price UP.
    const priceQuantum = units('0.000000000001');
    const buffered = (price + priceQuantum - 1n) / priceQuantum * priceQuantum;
    const priceNumber = Number(decimal(buffered));
    let quantity: number;
    try { quantity = quantityWithinBudget(capital, priceNumber); }
    catch { rejected(candidate.symbol, [portfolioBlock('unsupported_quantity', 'The affordable quantity exceeds the supported precision range.')]); continue; }
    const increment = units(numberDecimal(policy.quantityIncrement, 9, false));
    let quantityUnits = units(numberDecimal(quantity, 9)) / increment * increment;
    if (candidate.template.id !== 'trend-following') quantityUnits = quantityUnits / units('1') * units('1');
    // The final exact cash comparison also protects decimal-to-number conversion.
    while (quantityUnits > 0n && product(quantityUnits, buffered) > BigInt(capital) * units('0.01')) quantityUnits -= increment;
    quantity = Number(decimal(quantityUnits));
    try {
      validateQuantity(quantity);
      requireValue(units(numberDecimal(quantity, 9)) === quantityUnits, 'quantity', 'inexact_quantity');
    } catch { rejected(candidate.symbol, [portfolioBlock('quantity_below_increment', 'The affordable quantity cannot meet the configured share increment.')]); continue; }
    const riskBudget = ratio(capital, stress, true), trigger = Math.max(1, Math.min(riskBudget, ratio(capital, policy.lossTriggerBps)));
    const validUntil = [portfolio.validUntil, sizing.validUntil, candidate.entryWindow.to,
      new Date(Date.parse(at) + policy.proposalTtlMs).toISOString()].sort()[0];
    candidates.push({ symbol: candidate.symbol, status: 'allocated', blocks: [], capitalCents: capital, quantity,
      bufferedPriceUsd: decimal(buffered), allocationOnSnapshotEquityPct: { numerator: String(BigInt(capital) * 100n), denominator: String(equity) },
      riskBudgetCents: riskBudget, lossTriggerCents: trigger, constraints });
    drafts.push({ template: candidate.template, symbol: candidate.symbol, direction: 'long', sessionMode: candidate.sessionMode, supervision: 'browser',
      parameters: { ...candidate.parameters }, session: candidate.session, generatedAt: at, dataCutoff: candidate.dataCutoff,
      validUntil, dataProvenanceRef: candidate.evidence.snapshotRef,
      capital: { ceilingCents: capital, equityCents: equity, snapshotAt: portfolio.asOf },
      risk: { budgetCents: riskBudget, lossTriggerCents: trigger, policy: { id: policy.id, version: policy.version } },
      executionPolicy: candidate.executionPolicy, exitPolicy: candidate.exitPolicy, entryWindow: { ...candidate.entryWindow, from: at },
      intendedEnd: candidate.intendedEnd, adaptationBounds: {},
      rationale: [...candidate.rationale,
        `Robot target: ${policy.perRunCapBps / 100}% of account equity ${usd(equity)} = ${usd(perRunCap)}. Proposed capital ${usd(capital)}. ${binding}.`,
        'Allocation rank: complete observed daily dollar liquidity descending, then symbol; at most one plan per symbol.',
        `Sizing observation ${sizing.sourceRef} at ${sizing.asOf}; preview quantity ${quantity}; scenario ${stress} bps: ${sizing.stressRationale}`,
        `Allocation policy configuration: ${canonicalSerialize(policy)}`],
      risks: [...candidate.evidence.limitations, ...(candidate.sessionMode === '24x5' ? ['Extended and overnight orders use limits and may not fill. A separate regular-hours backup stop is attached after confirmed extended-hours fills. All protection outside regular hours requires the connected browser.'] : []), policy.rationale, 'Stress allowance and loss trigger do not guarantee a maximum loss. Pending proposals reserve no capital; approval must revalidate current portfolio and execution gates.'],
      blocks: [], evidence: { id: candidate.evidence.ref, policy: { id: candidate.researchPolicy.id, version: candidate.researchPolicy.version },
        status: 'experimental', provenance: templatePolicy(candidate.template).provenance, asOf: batch.generatedAt, dataCutoff: candidate.dataCutoff, limitations: candidate.evidence.limitations },
      forecast: candidate.forecast, allocatorPolicy: { id: policy.id, version: policy.version }, portfolioSnapshotRef: portfolio.id });
    capitalHeadroom -= capital; aggregateHeadroom -= capital; buyingPower -= capital; stressHeadroom -= riskBudget;
  }
  return structuredClone({ schemaVersion: 1, scope: portfolio.scope, evaluatedAt: at, policy, portfolio,
    researchSnapshotRef: research.snapshotRef, blocks, candidates, drafts });
}
