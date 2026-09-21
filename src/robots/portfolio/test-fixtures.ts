/** Synthetic account, research and ledger inputs; shared with mocked browser tests. */
import type { Position } from '../../core/types';
import type { TrendResearchBatch } from '../research/scheduler';
import type { TrendCandidate } from '../research/trend';
import { TREND_RESEARCH_POLICY } from '../research/trend';
import { unavailableForecast } from '../research/values';
import { trendFollowing } from '../templates/trend-following';
import { proposalFixture } from '../test-fixtures';
import { ALLOCATION_POLICY, type AllocationInput, type AllocationPolicy } from './allocation';

export type Mutable<T> = { -readonly [K in keyof T]: T[K] extends object ? Mutable<T[K]> : T[K] };
export const now = '2026-09-18T15:01:00.000Z';
export const later = '2026-09-18T15:01:30.000Z';
export const scope = { broker: 'alpaca', accountId: 'synthetic-allocation-account', environment: 'paper' as const };
export function allocationFixture(symbols = ['AAA', 'BBB']): Mutable<AllocationInput & { research: TrendResearchBatch }> {
  const session = proposalFixture().session;
  const candidates: TrendCandidate[] = symbols.map(symbol => ({ schemaVersion: 1, scope, symbol,
    template: trendFollowing.identity, direction: 'long', sessionMode: 'regular', supervision: 'browser',
    parameters: { fastPeriod: 5, slowPeriod: 20, stopLossPct: 1, trailingStopPct: 1 }, session,
    entryWindow: { from: now, to: '2026-09-18T19:45:00.000Z' }, intendedEnd: '2026-09-18T19:55:00.000Z',
    executionPolicy: trendFollowing.executionPolicy, exitPolicy: trendFollowing.exitPolicy, dataCutoff: now,
    researchPolicy: TREND_RESEARCH_POLICY, rationale: ['Synthetic selected research fixture'],
    evidence: { status: 'experimental', ref: `synthetic-evidence-${symbol}`, snapshotRef: 'synthetic-universe', testedCandidateCount: 1,
      assumptions: TREND_RESEARCH_POLICY.assumptions, limitations: ['Synthetic research; no measured safety claim.'] },
    forecast: unavailableForecast('No forecast estimator.') }));
  const input: AllocationInput = { evaluatedAt: now, portfolio: {
    id: 'synthetic-portfolio-1', scope, asOf: now, validUntil: later, brokerSourceRef: 'synthetic-broker', localSourceRef: 'synthetic-ledger',
    complete: { broker: true, local: true, reconciliation: true }, 
    account: { id: scope.accountId, equity: 10000, lastEquity: 10000, buyingPower: 10000, cash: 10000,
      portfolioValue: 10000, daytradeCount: null, tradingBlocked: false, createdAt: null },
    positions: [], orders: [], commitments: [], uncertain: false,
  }, research: { schemaVersion: 1, scope, connectionGeneration: 1, snapshotRef: 'synthetic-universe', generatedAt: now, dataCutoff: now,
    policy: TREND_RESEARCH_POLICY, universeBreadth: { availableAssets: symbols.length, inspectedAssets: symbols.length,
      liquidAssets: symbols.length, quotedAssets: symbols.length, omittedAssets: 0, omittedLiquidAssets: 0,
      selection: 'symbol-ascending-cap-then-prior-session-dollar-volume' },
    history: { source: 'alpaca:/v2/stocks/bars', feed: 'sip', adjustment: 'split', timeframe: '5Min', start: now, end: now },
    evaluations: candidates.map(candidate => ({ symbol: candidate.symbol, status: 'selected', reasonCode: 'fixture', reason: 'Synthetic selection', search: null, candidate })),
    counts: { inputSymbols: symbols.length, researchedSymbols: symbols.length, selectedSymbols: symbols.length, testedCandidates: symbols.length, historyRequests: 0 },
  }, sizing: symbols.map(symbol => ({ scope, symbol, sourceRef: `synthetic-sizing-${symbol}`, asOf: now, validUntil: later,
    priceUsd: 100, averageDailyDollarVolumeUsd: 10_000_000, liquidityComplete: true,
    stressedLossBps: 2000, stressRationale: 'Synthetic 20% adverse price scenario, not an estimate.' })) };
  return structuredClone(input) as Mutable<AllocationInput & { research: TrendResearchBatch }>;
}
export const policyFixture = (changes: Partial<AllocationPolicy> = {}): AllocationPolicy => ({ ...ALLOCATION_POLICY,
  id: 'synthetic-allocation-policy', accountCapitalBudgetBps: 10_000, aggregateStressBudgetBps: 10_000, ...changes });

export function position(symbol = 'MANUAL', qty = 2): Position { return { symbol, qty, side: 'long', avgEntryPrice: 100, currentPrice: 100, marketValue: qty * 100, unrealizedPl: 0, unrealizedPlpc: 0 }; }
export function order(id = 'manual-order', symbol = 'AAA') { return { id, symbol, side: 'buy' as const, qty: 10, filledQty: 0, type: 'limit', limitPrice: 100, status: 'new', submittedAt: now }; }
export async function addRun(input: Mutable<AllocationInput>, options: { symbol?: string; owned?: number; pending?: number; ended?: boolean; status?: string } = {}) {
  if (!options.ended) input.portfolio.commitments.push({ symbol: options.symbol ?? 'ROBOT', ceilingCents: 100000 });
  if (options.owned) input.portfolio.positions.push(position(options.symbol ?? 'ROBOT', options.owned));
}
