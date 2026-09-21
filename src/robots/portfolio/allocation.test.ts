import { describe, expect, it } from 'vitest';
import { numberDecimal, product, units } from '../../core/decimal';
import { snapshotProposal } from '../research/values';
import { trendFollowing } from '../templates/trend-following';
import { opportunityKey } from '../validation';
import { allocatePortfolio, ALLOCATION_POLICY } from './allocation';
import { addRun, allocationFixture, now, order, policyFixture, position } from './test-fixtures';



describe('deterministic conservative allocation', () => {
  it.each([[1000, 10000], [10000, 100000], [100000, 1000000], [99135.69, 991355], [1000000, 10000000]])(
    'scales new robot capital and risk to $%s equity without a fixed-dollar cap', (equity, ceilingCents) => {
      const input = allocationFixture(['AAA', 'BBB', 'CCC']);
      Object.assign(input.portfolio.account, { equity, cash: equity, buyingPower: equity * 4 });
      for (const sizing of input.sizing) sizing.averageDailyDollarVolumeUsd = 1_000_000_000;
      const result = allocatePortfolio(input);
      expect(result.drafts.map(plan => plan.capital.ceilingCents)).toEqual([ceilingCents, ceilingCents, ceilingCents]);
      for (const plan of result.drafts) {
        expect(plan.risk.budgetCents).toBe(Math.ceil(ceilingCents * .2));
        expect(plan.risk.lossTriggerCents).toBe(Math.floor(ceilingCents * .05));
        expect(plan.capital.equityCents).toBe(Math.round(equity * 100));
        expect(plan.rationale.join(' ')).toContain('10% of account equity');
      }
    });
  it('scales to equity while sharing limited cash across a proposal batch', () => {
    const input = allocationFixture(['AAA', 'BBB', 'CCC']);
    Object.assign(input.portfolio.account, { equity: 100000, cash: 15000, buyingPower: 400000 });
    const result = allocatePortfolio(input);
    expect(result.drafts.map(plan => plan.capital.ceilingCents)).toEqual([1000000, 500000]);
    expect(result.candidates[2].blocks[0].reason).toContain('Available cash and buying power: $0.00');
    expect(result.drafts[1].rationale.join(' ')).toContain('Available cash and buying power: $5,000.00');
  });
  it('accounts for existing robots when allocating for the reported $99k account', () => {
    const input = allocationFixture(['AAA', 'BBB', 'CCC']);
    Object.assign(input.portfolio.account, { equity: 99135.69, cash: 99135.69, buyingPower: 394346.81 });
    input.portfolio.commitments = ['AMD', 'AAPL', 'AMAT'].map(symbol => ({ symbol, ceilingCents: 100000 }));
    input.portfolio.orders = input.portfolio.commitments.map(({ symbol }) => order(`order-${symbol}`, symbol));
    const result = allocatePortfolio(input);
    expect(result.drafts.map(plan => plan.capital.ceilingCents)).toEqual([991355, 991355, 991355]); // Risk allowances round down to cents too.
    expect(input.portfolio.commitments.map(value => value.ceilingCents)).toEqual([100000, 100000, 100000]);
  });
  it('starts an offer at its generation time after asynchronous research and account reads', async () => {
    const input = allocationFixture(['AAA']);
    input.evaluatedAt = new Date(Date.parse(input.evaluatedAt) + 2000).toISOString();
    const draft = allocatePortfolio(input).drafts[0];
    expect(draft.entryWindow.from).toBe(input.evaluatedAt);
    const { estimateSessionEnd } = await import('../research/forecasts');
    const report = await estimateSessionEnd({ scope: input.portfolio.scope, plan: draft, provenance: 'paper_execution',
      costs: input.research.policy.assumptions, features: { asOf: draft.dataCutoff, priceUsd: 100, dailyLiquidityUsd: 10000000 } },
      { observations: [], missing: [], rosterComplete: true });
    expect(report.diagnostics.reasons).not.toContain('future_target_context');
    expect(report.forecast.status).toBe('unavailable');
  });
  it('shares affordable headroom across two competing plans and keeps exact equity denominators', () => {
    const input = allocationFixture(['BBB', 'AAA']); input.portfolio.account.buyingPower = 1500;
    const result = allocatePortfolio(input);
    expect(result.drafts.map(row => [row.symbol, row.capital.ceilingCents])).toEqual([['AAA', 100000], ['BBB', 50000]]);
    expect(result.candidates[1]).toMatchObject({ riskBudgetCents: 10000, lossTriggerCents: 2500,
      allocationOnSnapshotEquityPct: { numerator: '5000000', denominator: '1000000' } });
    for (const [index, draft] of result.drafts.entries()) {
      const row = { ...draft, schemaVersion: 1 as const, scope: input.portfolio.scope, id: `test-${index}`, revision: 1,
        opportunityKey: opportunityKey({ ...draft, scope: input.portfolio.scope }) };
      expect(snapshotProposal(row, [trendFollowing])).toEqual(row);
    }
    expect(input.portfolio.commitments).toEqual([]);
  });
  it('ranks by liquidity then symbol, caps to three, and is independent of input ordering', () => {
    const input = allocationFixture(['DDD', 'CCC', 'BBB', 'AAA']);
    input.sizing.find(row => row.symbol === 'CCC')!.averageDailyDollarVolumeUsd = 20_000_000;
    const first = allocatePortfolio(input); input.research.evaluations.reverse(); input.sizing.reverse();
    expect(allocatePortfolio(input)).toEqual(first);
    expect(first.drafts.map(row => row.symbol)).toEqual(['CCC', 'AAA', 'BBB']);
    expect(first.candidates[3].blocks[0].code).toBe('batch_limit');
  });
  it.each(['position', 'order', 'idle'])('blocks a symbol claimed by a manual/active %s', async kind => {
    const input = allocationFixture();
    if (kind === 'position') input.portfolio.positions = [position('AAA')];
    if (kind === 'order') input.portfolio.orders = [order('manual', 'AAA')];
    if (kind === 'idle') await addRun(input, { symbol: 'AAA' });
    const result = allocatePortfolio(input, policyFixture());
    expect(result.candidates.find(row => row.symbol === 'AAA')!.blocks).toContainEqual(expect.objectContaining({ code: 'symbol_conflict' }));
    expect(result.drafts.map(row => row.symbol)).toEqual(['BBB']);
  });
  it.each([
    ['accountCapitalBudgetBps', 750, 75000], ['perRunCapBps', 250, 25000],
    ['symbolConcentrationBps', 500, 50000], ['aggregateExposureBps', 500, 50000],
    ['perRunRiskBudgetBps', 50, 25000], ['aggregateStressBudgetBps', 50, 25000],
    ['dailyLiquidityParticipationBps', 1, 100000],
  ] as const)('enforces %s', (key, value, expected) => {
    const input = allocationFixture(['AAA']);
    const result = allocatePortfolio(input, policyFixture({ [key]: value }));
    expect(result.drafts[0].capital.ceilingCents).toBe(expected);
  });
  it('uses manual exposure and idle policies against the account and aggregate budgets', async () => {
    const input = allocationFixture(); await addRun(input); input.portfolio.positions = [position('MANUAL', 5)];
    const result = allocatePortfolio(input, policyFixture({ accountCapitalBudgetBps: 2750 }));
    expect(result.drafts.map(row => row.capital.ceilingCents)).toEqual([100000, 25000]); // 2750 - 1000 - 500
  });
  it('applies the full-capital existing-exposure stress bound, never zero unknown risk', () => {
    const input = allocationFixture(); input.portfolio.positions = [position('MANUAL', 19)];
    const result = allocatePortfolio(input);
    expect(result.drafts.map(row => row.capital.ceilingCents)).toEqual([50000]); // (2000 - 1900) / .2
  });
  it('does not use leveraged buying power beyond cash or account equity', () => {
    const input = allocationFixture(); input.portfolio.account.buyingPower = 40000; input.portfolio.account.cash = 250;
    expect(allocatePortfolio(input).drafts.map(row => row.capital.ceilingCents)).toEqual([25000]);
  });
  it('bounds size by complete observed liquidity', () => {
    const input = allocationFixture(['AAA']); input.sizing[0].averageDailyDollarVolumeUsd = 123456;
    expect(allocatePortfolio(input).drafts[0].capital.ceilingCents).toBe(12345);
  });
  it.each([0, 0.5, 0.99])('exposes insufficient buying power %s', buyingPower => {
    const input = allocationFixture(); input.portfolio.account.buyingPower = buyingPower;
    const result = allocatePortfolio(input); expect(result.drafts).toEqual([]);
    expect(result.candidates[0].blocks[0].reason).toContain('Available cash and buying power');
  });
  it('explains the scaled stress budget that blocks a portfolio with large existing exposure', () => {
    const input = allocationFixture(['AAA']); input.portfolio.positions = [position('MANUAL', 500)];
    input.portfolio.account.equity = 100_000;
    const result = allocatePortfolio(input);
    expect(result.drafts).toEqual([]);
    expect(result.candidates[0].blocks[0]).toEqual({ category: 'portfolio', code: 'insufficient_capacity',
      reason: 'Available allocation $0.00 is below the $1.00 minimum. Stress budget: $0.00 remaining of $20,000.00; existing exposure stress $50,000.00; per-run allowance $2,000.00.' });
  });
  it.each(['stress', 'rationale', 'liquidity', 'coverage', 'price', 'stale', 'future', 'scope', 'duplicate'])('keeps unavailable %s inputs unavailable', mode => {
    const input = allocationFixture(['AAA']);
    if (mode === 'stress') input.sizing[0].stressedLossBps = null;
    if (mode === 'rationale') input.sizing[0].stressRationale = null;
    if (mode === 'liquidity') input.sizing[0].averageDailyDollarVolumeUsd = null;
    if (mode === 'coverage') input.sizing[0].liquidityComplete = false;
    if (mode === 'price') input.sizing[0].priceUsd = null;
    if (mode === 'stale') input.sizing[0].asOf = '2026-09-18T15:00:00.000Z';
    if (mode === 'future') input.sizing[0].asOf = '2026-09-18T15:01:01.000Z';
    if (mode === 'scope') input.sizing[0].scope = { ...input.sizing[0].scope, accountId: 'another-account' };
    if (mode === 'duplicate') input.sizing.push(structuredClone(input.sizing[0]));
    const result = allocatePortfolio(input); expect(result.drafts).toEqual([]);
    expect(result.candidates[0]).toMatchObject({ capitalCents: null, quantity: null, riskBudgetCents: null });
    expect(result.candidates[0].blocks.length).toBeGreaterThan(0);
  });
  it.each(['portfolio', 'research', 'closed_session', 'wrong_account', 'duplicate_symbol'])('blocks obsolete or invalid %s', mode => {
    const input = allocationFixture(['AAA']);
    if (mode === 'portfolio') input.portfolio.asOf = '2026-09-18T15:00:00.000Z';
    if (mode === 'research') input.research.dataCutoff = '2026-09-18T14:00:00.000Z';
    if (mode === 'closed_session') input.research.evaluations[0].candidate = { ...input.research.evaluations[0].candidate!, entryWindow: { from: now, to: now } };
    if (mode === 'wrong_account') input.research.scope = { ...input.research.scope, accountId: 'another-account' };
    if (mode === 'duplicate_symbol') input.research.evaluations.push(structuredClone(input.research.evaluations[0]));
    expect(allocatePortfolio(input).drafts).toEqual([]);
  });
  it('rounds fractional quantity downward with exact cash comparison and retains a separate capital ceiling', () => {
    const input = allocationFixture(['AAA']); input.portfolio.account.buyingPower = 10;
    input.sizing[0].priceUsd = 3;
    const result = allocatePortfolio(input, policyFixture({ entryPriceBufferBps: 0, quantityIncrement: 0.01 }));
    expect(result.candidates[0]).toMatchObject({ capitalCents: 1000, quantity: 3.33, bufferedPriceUsd: '3' });
    const row = result.candidates[0];
    expect(product(units(numberDecimal(row.quantity!, 9)), units(row.bufferedPriceUsd!)) <= units('10')).toBe(true);
  });
  it('floors awkward prices, fractional money, and full-share increments without overspend', () => {
    for (const price of [0.07, 3.333333333333, 999.99, 1001]) {
      const input = allocationFixture(['AAA']); input.portfolio.account.buyingPower = 10.009; input.sizing[0].priceUsd = price;
      const result = allocatePortfolio(input, policyFixture({ quantityIncrement: 0.000000001 }));
      const row = result.candidates[0]; expect(row.capitalCents).toBe(1000);
      expect(product(units(numberDecimal(row.quantity!, 9)), units(row.bufferedPriceUsd!)) <= units('10')).toBe(true);
    }
    const input = allocationFixture(['AAA']); input.portfolio.account.buyingPower = 10;
    expect(allocatePortfolio(input, policyFixture({ quantityIncrement: 1 })).candidates[0].blocks[0].code).toBe('quantity_below_increment');
  });
  it('preserves immutable snapshots, experimental evidence and unavailable forecasts', () => {
    const input = allocationFixture(), result = allocatePortfolio(structuredClone(input));
    input.portfolio.account.equity = 1; input.sizing[0].priceUsd = 1;
    expect(result.drafts[0].capital.equityCents).toBe(1000000);
    expect(result.drafts[0].evidence.status).toBe('experimental'); expect(result.drafts[0].forecast.meanPnlCents).toBeNull();
     
  });
  it('blocks supported-price observations whose proposed quantity exceeds domain precision', () => {
    const input = allocationFixture(['AAA']); input.sizing[0].priceUsd = 0.000000000001;
    const result = allocatePortfolio(input); expect(result.drafts).toEqual([]);
    expect(result.candidates[0].blocks[0].code).toBe('unsupported_quantity');
  });
  it('accepts an empty research batch without fabricating a proposal', () => {
    expect(allocatePortfolio(allocationFixture([])).drafts).toEqual([]);
  });
  it('requires a new policy identity/version when tuning defaults and rejects invalid configuration', () => {
    expect(() => allocatePortfolio(allocationFixture(), { ...ALLOCATION_POLICY, perRunCapBps: 1 })).toThrow('version_configuration_mismatch');
    expect(() => allocatePortfolio(allocationFixture(), policyFixture({ maxProposals: 4 }))).toThrow('resource_limit');
    expect(() => allocatePortfolio(allocationFixture(), policyFixture({ existingExposureStressBps: 0 }))).toThrow();
  });
});
