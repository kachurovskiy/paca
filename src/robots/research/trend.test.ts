import { afterEach, describe, expect, it, vi } from 'vitest';
import { searchMomentum, type MomentumSearchResult } from '../math/momentum';
import { researchTrend, TREND_RESEARCH_POLICY, type TrendResearchInput } from './trend';
import { trendFixture } from './trend-fixtures';

vi.mock('../math/momentum', async original => {
  const module = await original<typeof import('../math/momentum')>();
  return { ...module, searchMomentum: vi.fn(module.searchMomentum) };
});
afterEach(() => vi.mocked(searchMomentum).mockReset());

async function input(): Promise<TrendResearchInput> {
  const fixture = trendFixture(2), snapshot = await fixture.capture();
  return { scope: snapshot.scope, snapshotRef: snapshot.id, symbol: 'S0001', dataCutoff: snapshot.dataCutoff,
    session: snapshot.session, sessions: [...snapshot.previousSessions, snapshot.session],
    bars: fixture.history('S0001', { start: fixture.now - 7 * 86_400_000, end: fixture.now, timeframe: '5Min' }) };
}
function finish(value: TrendResearchInput) {
  const job = researchTrend(value); let step = job.next();
  while (!step.done) step = job.next();
  return step.value;
}

describe('experimental policy and template bounds', () => {
  it('retains existing deterministic search regardless of input ordering', async () => {
    const value = await input();
    expect(finish({ ...value, bars: [...value.bars].reverse() })).toEqual(finish(value));
    expect(TREND_RESEARCH_POLICY.minimum).toEqual({ sessions: 4, completedBarsPerSession: 48, trainingTrades: 3, heldOutTrades: 2, returnPctExclusive: 0 });
    
  });

  it.each([
    { fastPeriod: 4, slowPeriod: 4, stopLossPct: 1, trailingStopPct: 1 },
    { fastPeriod: 1, slowPeriod: 16, stopLossPct: 1, trailingStopPct: 1 },
    { fastPeriod: 4, slowPeriod: 61, stopLossPct: 1, trailingStopPct: 1 },
    { fastPeriod: 4, slowPeriod: 16, stopLossPct: 0, trailingStopPct: 1 },
    { fastPeriod: 4, slowPeriod: 16, stopLossPct: 1, trailingStopPct: 6 },
  ])('blocks out-of-contract optimizer parameters before simulation: %j', async parameters => {
    let resumed = false;
    vi.mocked(searchMomentum).mockImplementationOnce(function* () {
      yield { phase: 'training', parameters, testedCandidates: 0 }; resumed = true;
      return {} as MomentumSearchResult;
    });
    expect(finish(await input())).toMatchObject({ status: 'unavailable', reasonCode: 'invalid_parameters', candidate: null });
    expect(resumed).toBe(false);
  });

  it('stops before a simulation that would exceed the parameter budget', async () => {
    let resumed = false;
    vi.mocked(searchMomentum).mockImplementationOnce(function* () {
      yield { phase: 'training', parameters: { fastPeriod: 4, slowPeriod: 16, stopLossPct: 1, trailingStopPct: 1 }, testedCandidates: 66 };
      resumed = true; return {} as MomentumSearchResult;
    });
    expect(finish(await input())).toMatchObject({ status: 'unavailable', reasonCode: 'search_budget', candidate: null });
    expect(resumed).toBe(false);
  });

  it.each(['empty_account', 'empty_symbol', 'invalid_time', 'closed'] as const)('rejects invalid pure research input: %s', async kind => {
    let value = await input();
    if (kind === 'empty_account') value = { ...value, scope: { ...value.scope, accountId: '' } };
    if (kind === 'empty_symbol') value = { ...value, symbol: '' };
    if (kind === 'invalid_time') value = { ...value, dataCutoff: 'invalid' };
    if (kind === 'closed') value = { ...value, dataCutoff: value.session.closeAt };
    expect(finish(value)).toMatchObject({ status: 'unavailable', reasonCode: 'invalid_research_input' });
    expect(searchMomentum).not.toHaveBeenCalled();
  });
});
