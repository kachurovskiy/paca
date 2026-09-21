import { describe, expect, it } from 'vitest';
import { inputFixture } from '../robots/templates/test-fixtures';
import { wickCapture } from '../robots/templates/wick-capture';
import { vwapMeanReversion } from '../robots/templates/vwap-mean-reversion';
import { backupStopPrice } from './protection';

describe('approved broker backup stop', () => {
  it('uses the tighter strategy stop or run loss trigger for every strategy', () => {
    const plan = inputFixture().approved.plan;
    expect(backupStopPrice(plan, 106, 9, 106)).toBe(103.88);
    expect(backupStopPrice(plan, 100, 100, 100)).toBe(99.5);
    expect(backupStopPrice(inputFixture(wickCapture).approved.plan, 100, 10, 100)).toBe(95);
    expect(backupStopPrice(inputFixture(vwapMeanReversion).approved.plan, 100, 10, 100)).toBe(99);
  });
  it('rounds to supported price increments and refuses fractional or already breached protection', () => {
    const plan = inputFixture().approved.plan;
    expect(backupStopPrice(plan, 10.123, 5, 10.123)).toBe(9.92);
    expect(backupStopPrice(plan, 0.8, 5, 0.8)).toBe(0.784);
    expect(() => backupStopPrice(plan, 106, 0.5, 106)).toThrow('whole shares');
    expect(() => backupStopPrice(plan, 106, 9, 100)).toThrow('cannot be placed');
    plan.parameters.stopLossPct = 0.000001;
    expect(() => backupStopPrice(plan, 0.1, 5, 0.1)).toThrow('cannot be placed');
  });
});
