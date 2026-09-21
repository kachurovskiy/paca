import { describe, expect, it } from 'vitest';
import { inputFixture, iso, NOW } from '../robots/templates/test-fixtures';
import { projectRunMetrics } from './accounting';
import { EXECUTION_CONTRACT, type Run } from '../trading/records';
import { entryRiskBlock, observeFills, observeOrder, ownedInventory } from '../trading/facts';

function fixture(rows: [side: 'buy' | 'sell', qty: number, price: number, fee: string | null][]): Run {
  const approved = inputFixture().approved;
  return { key: 'synthetic', scope: 'synthetic', contract: EXECUTION_CONTRACT, id: 'test', approvalCommandId: 'test', active: 1,
    state: 'paused', blocked: null, supervisionInterrupted: false, exitRequested: false, approved, ceilingCents: 100000, strategy: inputFixture().state,
    orders: rows.map(([side, qty, price], i) => ({ id: `order-${i}`, clientOrderId: `client-${i}`, symbol: 'TEST', side, qty, filledQty: qty,
      filledAvgPrice: price, type: 'market', status: 'filled', submittedAt: iso(NOW + i * 1000), filledAt: iso(NOW + i * 1000) })),
    fills: rows.map(([side, qty, price, feeUsd], i) => ({ id: `fill-${i}`, orderId: `order-${i}`, symbol: 'TEST', side, qty, price, feeUsd,
      transactionTime: iso(NOW + i * 1000), type: 'fill' })), commands: [], latestDecision: null, reconciledAt: iso(NOW), endedAt: null };
}
const asOf = iso(NOW + 10000);
describe('precise current run accounting', () => {
  it('retains FIFO partial-lot cost, exact fees and the approved allocation denominator', () => {
    const run = fixture([['buy', 2, 100, '0.2'], ['buy', 3, 110, '0.3'], ['sell', 3, 120, '0.4']]);
    const metrics = projectRunMetrics(run, asOf, { priceUsd: 120, at: asOf });
    expect(metrics.grossRealizedPnlUsd.value).toBe('50');
    expect(metrics.remainingEntryBasisUsd.value).toBe('220');
    expect(metrics.grossUnrealizedPnlUsd.value).toBe('20');
    expect(metrics.recordedTradeCashFlowUsd.value).toBe('-170');
    expect(metrics.netTotalPnlUsd.value).toBe('69.1');
    expect(metrics.netReturnOnAllocationPct.value).toEqual({ numerator: '6910', denominator: '1000' });
    expect(metrics.capital.committedBudgetUsd.value).toBe('1000');
  });
  it('sums separate round trips without charging the remaining lot twice', () => {
    const run = fixture([['buy', 2, 100, '0.1'], ['sell', 2, 110, '0.1'], ['buy', 3, 110, '0.1'], ['sell', 3, 105, '0.1']]);
    const metrics = projectRunMetrics(run, asOf);
    expect(metrics.grossRealizedPnlUsd.value).toBe('5'); expect(metrics.netTotalPnlUsd.value).toBe('4.6');
    expect(metrics.remainingEntryBasisUsd.value).toBe('0');
  });
  it('preserves fractional shares, sub-cent fees and nanoshare products', () => {
    const run = fixture([['buy', .3, .333333333333, '0.000000000001'], ['sell', .1, .666666666666, '0.000000000002']]);
    const metrics = projectRunMetrics(run, asOf, { priceUsd: 1, at: asOf });
    expect(metrics.grossRealizedPnlUsd.value).toBe('0.0333333333333');
    expect(metrics.remainingEntryBasisUsd.value).toBe('0.0666666666666');
    expect(metrics.grossUnrealizedPnlUsd.value).toBe('0.1333333333334');
    expect(metrics.netTotalPnlUsd.value).toBe('0.1666666666637');
    const tiny = fixture([['buy', 1e-9, 1e-12, '0']]);
    expect(projectRunMetrics(tiny, asOf).remainingEntryBasisUsd.value).toBe('0.000000000000000000001');
    expect(ownedInventory(tiny).quantity).toBe(1e-9);
  });
  it('keeps missing fees, marks and activity costs unavailable instead of zero', () => {
    const run = fixture([['buy', 1, 100, null]]);
    const metrics = projectRunMetrics(run, asOf, { priceUsd: 110, at: asOf });
    expect(metrics.grossTotalPnlUsd.value).toBe('10'); expect(metrics.netTotalPnlUsd.value).toBeNull();
    expect(projectRunMetrics(run, asOf, { priceUsd: 110, at: iso(NOW - 60000) }).markedInventoryUsd.value).toBeNull();
    run.fills = [];
    expect(ownedInventory(run)).toMatchObject({ quantity: 1, averageEntryPriceUsd: null, entryAt: null });
    expect(projectRunMetrics(run, asOf).grossRealizedPnlUsd.value).toBeNull();
    expect(entryRiskBlock(run, 100)).toContain('incomplete');
  });
  it('uses observed prices for the loss trigger while keeping unreported fees unknown', () => {
    const run = fixture([['buy', 10, 100, null]]);
    run.approved = { ...run.approved, plan: { ...run.approved.plan, risk: { ...run.approved.plan.risk, lossTriggerCents: 5000 } } };
    expect(entryRiskBlock(run, 96)).toBeNull(); expect(entryRiskBlock(run, 95)).toContain('loss trigger');
  });
  it('deduplicates activities, sorts out-of-order facts and refuses changed identities', () => {
    const run = fixture([['buy', 2, 100, null], ['sell', 1, 110, null]]), expected = projectRunMetrics(run, asOf);
    run.fills = observeFills(run, [...run.fills].reverse().concat(run.fills));
    expect(projectRunMetrics(run, asOf)).toEqual(expected);
    expect(() => observeFills(run, [{ ...run.fills[0], qty: 3 }])).toThrow('identity changed');
    const filled = { ...run.orders[0], updatedAt: asOf };
    expect(observeOrder([filled], { ...filled, filledQty: 1, updatedAt: iso(NOW) })[0].filledQty).toBe(2);
    expect(() => observeOrder([filled], { ...filled, filledQty: 1, updatedAt: iso(NOW + 20000) })).toThrow('regress');
  });
});
