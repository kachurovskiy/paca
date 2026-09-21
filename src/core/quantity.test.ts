import { describe, expect, it } from 'vitest';
import { portfolioQuantityPresets } from './quantity';

const buy = { side: 'buy' as const, equity: 100_000, buyingPower: 100_000, price: 1 };

describe('portfolio-sized whole-share presets', () => {
  it('offers 5k, 10k, 25k and 50k shares for a $100k portfolio and $1 stock', () => {
    expect(portfolioQuantityPresets(buy)).toEqual([5000, 10000, 25000, 50000]);
    expect(portfolioQuantityPresets({ ...buy, price: 2 })).toEqual([2500, 5000, 12500, 25000]);
  });
  it('rounds down to clean share counts as stock prices increase', () => {
    expect(portfolioQuantityPresets({ ...buy, price: 123 })).toEqual([40, 80, 200, 400]);
    expect(portfolioQuantityPresets({ ...buy, price: 610 })).toEqual([8, 15, 40, 80]);
  });
  it('uses equity rather than leveraged buying power and caps unaffordable choices', () => {
    expect(portfolioQuantityPresets({ ...buy, buyingPower: 400_000 })).toEqual([5000, 10000, 25000, 50000]);
    expect(portfolioQuantityPresets({ ...buy, buyingPower: 7000 })).toEqual([5000, 7000]);
    expect(portfolioQuantityPresets({ ...buy, buyingPower: 0.5 })).toEqual([]);
  });
  it('deduplicates tiny allocations and respects the existing whole-share order cap', () => {
    expect(portfolioQuantityPresets({ ...buy, price: 60_000 })).toEqual([1]);
    expect(portfolioQuantityPresets({ ...buy, price: 200_000 })).toEqual([]);
    expect(portfolioQuantityPresets({ ...buy, price: 0.01 })).toEqual([100_000]);
  });
  it('does not invent allocations when account or price data are missing or invalid', () => {
    for (const value of [undefined, 0, -1, NaN, Infinity]) {
      expect(portfolioQuantityPresets({ ...buy, equity: value })).toEqual([]);
      expect(portfolioQuantityPresets({ ...buy, price: value })).toEqual([]);
      expect(portfolioQuantityPresets({ ...buy, buyingPower: value })).toEqual([]);
    }
  });
  it('sizes sell presets from long holdings, retaining the full whole-share exit', () => {
    expect(portfolioQuantityPresets({ side: 'sell', holdings: 73.75 })).toEqual([15, 35, 50, 73]);
    expect(portfolioQuantityPresets({ side: 'sell', holdings: 3 })).toEqual([1, 2, 3]);
    for (const holdings of [undefined, 0, -10, 0.75, NaN, Infinity]) {
      expect(portfolioQuantityPresets({ side: 'sell', holdings })).toEqual([]);
    }
  });
});
