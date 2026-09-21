import { allocatePortfolio } from '../portfolio/allocation';
import { allocationFixture, now, scope } from '../portfolio/test-fixtures';
import { TREND_RESEARCH_POLICY } from './trend';
import type { ProposalDraft } from './proposals';
import type { Bar } from '../../core/types';
export { now, scope };
export const plus = (at: string, milliseconds: number) => new Date(Date.parse(at) + milliseconds).toISOString();
export function prospectiveDraft(short = false): ProposalDraft {
  const draft = structuredClone(allocatePortfolio(allocationFixture(['AAA'])).drafts[0]);
  return short ? { ...draft, validUntil: plus(now, 10_000), entryWindow: { from: now, to: plus(now, 15_000) },
    intendedEnd: plus(now, 20_000) } : draft;
}
export function prospectiveCapture(draft = prospectiveDraft()) {
  return { template: draft.template, policy: draft.evidence.policy, symbol: draft.symbol, parameters: draft.parameters,
    session: draft.session, intendedEnd: draft.intendedEnd, selection: 'offered' as const, reasons: [], dataCutoff: draft.dataCutoff,
    source: { snapshotRef: draft.dataProvenanceRef, asOf: draft.dataCutoff, symbols: [draft.symbol], membership: 'recorded_shortlist' as const,
      inputSymbols: 1, testedConfigurations: 3 }, evidence: draft.evidence, assumptions: TREND_RESEARCH_POLICY.assumptions,
    features: { asOf: draft.dataCutoff, priceUsd: 100, dailyLiquidityUsd: 10_000_000 } };
}
export function prospectiveBars(plan = prospectiveDraft(), rising = false): Bar[] {
  return Array.from({ length: 78 }, (_, index) => {
    const p = rising ? 100 + index / 5 : 100;
    return { t: plus(plan.session.openAt, index * 300_000), o: p, h: p + 0.1, l: p - 0.1, c: p, v: 1000 };
  });
}
