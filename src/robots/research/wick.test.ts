import { describe, expect, it } from 'vitest';
import { allocatePortfolio, type AllocationInput } from '../portfolio/allocation';
import { allocationFixture } from '../portfolio/test-fixtures';
import { researchTrend } from './trend';
import { trendFixture } from './trend-fixtures';
import { researchWick, WICK_RESEARCH_POLICY } from './wick';

describe('bounded observation-only Wick selection', () => {
  
  it('selects neutral targets independently of rejected Trend history without inventing fills or forecasts', async () => {
    const f = trendFixture(), snapshot = await f.capture(), batch = researchWick(snapshot, snapshot.asOf);
    expect(batch.counts).toMatchObject({ researchedSymbols: 3, selectedSymbols: 3, testedCandidates: 9, historyRequests: 0 });
    const candidate = batch.evaluations.find(row => row.symbol === 'S0000')!.candidate!;
    expect(candidate.parameters).toEqual({ dipPct: 1, holdMinutes: 10 }); expect(candidate.forecast.status).toBe('unavailable');
     expect(candidate.evidence.limitations.join(' ')).toContain('no profitability');
    const search = researchTrend({ scope: snapshot.scope, symbol: 'S0000', snapshotRef: snapshot.id, session: snapshot.session,
      sessions: snapshot.previousSessions, dataCutoff: snapshot.dataCutoff,
      bars: f.history('S0000', { start: f.now - 7 * 86_400_000, end: f.now, timeframe: '5Min' }) });
    let result = search.next(); while (!result.done) result = search.next();
    expect(result.value.candidate).toBeNull(); expect(candidate.template.id).toBe('wick-capture');
  });
  it('caps inspected symbols and fixed settings independently of universe size', async () => {
    const snapshot = await trendFixture(8).capture(), batch = researchWick(snapshot, snapshot.asOf);
    expect(batch.counts.testedCandidates).toBe(12); expect(batch.evaluations.filter(row => row.status === 'omitted')).toHaveLength(4);
    expect(batch.evaluations.flatMap(row => row.candidate ? [row.candidate.parameters] : [])).toEqual(Array(4).fill(WICK_RESEARCH_POLICY.settings[1]));
  });
  it('accepts live scope while refusing stale contexts and missing or wide bid/ask data', async () => {
    const snapshot = structuredClone(await trendFixture().capture());
    const live = { ...snapshot, scope: { ...snapshot.scope, environment: 'live' as const } };
    expect(researchWick(live, live.asOf).evaluations.every(row => row.candidate?.scope.environment === 'live')).toBe(true);
    expect(() => researchWick(snapshot, new Date(Date.parse(snapshot.asOf) + 61_000).toISOString())).toThrow();
    expect(() => researchWick({ ...live, scope: { ...live.scope, accountId: '' } }, live.asOf)).toThrow();
    const candidates = snapshot.candidates.map((row, index) => ({ ...row, quote: index === 0 ? null : { ...row.quote!, ask: row.quote!.bid! * 1.01 } }));
    expect(researchWick({ ...live, candidates }, live.asOf).counts.selectedSymbols).toBe(0);
    expect(researchWick({ ...live, candidates }, live.asOf).evaluations[1].reasonCode).toBe('wick_spread_limit');
  });
  it('shares capital and symbol exclusion with Trend, and retains shadow provenance and unavailable forecast', async () => {
    const snapshot = await trendFixture(1).capture(), wick = researchWick(snapshot, snapshot.asOf), original = allocationFixture(['S0000']);
    const candidate = wick.evaluations[0].candidate!;
    const at = snapshot.asOf, until = new Date(Date.parse(at) + 30_000).toISOString();
    const input: AllocationInput = { ...original, evaluatedAt: at, research: wick,
      portfolio: { ...original.portfolio, account: { ...original.portfolio.account, id: snapshot.scope.accountId }, scope: snapshot.scope, asOf: at, validUntil: until },
      sizing: original.sizing.map(row => ({ ...row, scope: snapshot.scope, asOf: at, validUntil: until })) };
    const one = allocatePortfolio(input); expect(one.drafts).toHaveLength(1);
    expect(one.drafts[0].evidence.provenance).toBe('shadow'); expect(one.drafts[0].forecast.status).toBe('unavailable');
    const trend = { ...original.research, scope: snapshot.scope, snapshotRef: snapshot.id, generatedAt: at, dataCutoff: at,
      evaluations: original.research.evaluations.map(row => ({ ...row, candidate: { ...row.candidate!, scope: snapshot.scope,
        session: snapshot.session, dataCutoff: at, entryWindow: candidate.entryWindow, intendedEnd: candidate.intendedEnd,
        evidence: { ...row.candidate!.evidence, snapshotRef: snapshot.id } } })) };
    const competing = allocatePortfolio({ ...input, alternatives: [trend] });
    expect(competing.drafts).toHaveLength(1); expect(competing.drafts[0].template.id).toBe('trend-following');
    expect(competing.candidates.some(row => row.blocks.some(block => block.code === 'symbol_competition'))).toBe(true);
    const claimed = { ...input, portfolio: { ...input.portfolio, complete: { broker: true, local: false, reconciliation: false } } };
    expect(allocatePortfolio(claimed).drafts).toEqual([]);
  });
});
