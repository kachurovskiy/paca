import { describe, expect, it } from 'vitest';
import { automaticBuyingPower, automaticBuyQuantity, automaticLimitPrice } from './auto-order';

describe('automatic executable limit prices', () => {
  it.each([
    { bid: 501.001, ask: 501.009, buy: 501.01, sell: 501 },
    { bid: 1.15, ask: 1.16, buy: 1.16, sell: 1.15 },
    { bid: 0.12341, ask: 0.12349, buy: 0.1235, sell: 0.1234 },
    { bid: 0.29, ask: 0.29, buy: 0.29, sell: 0.29 },
    { bid: 0.99999, ask: 0.99999, buy: 1, sell: 0.9999 },
    { bid: 1, ask: 1.00001, buy: 1.01, sell: 1 },
  ])('rounds the ask up and bid down without adding a tick to an exact price: $bid/$ask', ({ bid, ask, buy, sell }) => {
    expect(automaticLimitPrice('buy', bid, ask)).toBe(buy);
    expect(automaticLimitPrice('sell', bid, ask)).toBe(sell);
  });

  it.each([null, undefined, 0, -1, NaN, Infinity, -Infinity])('requires both sides of the quote to be valid: %s', invalid => {
    for (const side of ['buy', 'sell'] as const) {
      expect(automaticLimitPrice(side, invalid, 100)).toBeNull();
      expect(automaticLimitPrice(side, 100, invalid)).toBeNull();
    }
  });

  it('rejects crossed quotes and sell prices smaller than the minimum tick', () => {
    expect(automaticLimitPrice('buy', 101, 100)).toBeNull();
    expect(automaticLimitPrice('sell', 101, 100)).toBeNull();
    expect(automaticLimitPrice('sell', 0.00001, 0.00002)).toBeNull();
    expect(automaticLimitPrice('buy', 0.00001, 0.00002)).toBe(0.0001);
  });
});

describe('automatic share sizing', () => {
  it('rounds the chosen allocation down to whole shares', () => {
    expect(automaticBuyQuantity(100_000, 100_000, 501.01, 5)).toBe(9);
    expect(automaticBuyQuantity(100_000, 100_000, 501.01, 10)).toBe(19);
  });

  it('caps the allocation by available buying power and the order share limit', () => {
    expect(automaticBuyQuantity(100_000, 1_100, 501.01, 5)).toBe(2);
    expect(automaticBuyQuantity(10_000_000, 10_000_000, 0.01, 100)).toBe(100_000);
  });

  it('does not force one share when either budget cannot afford it', () => {
    expect(automaticBuyQuantity(10_000, 10_000, 501.01, 5)).toBe(0);
    expect(automaticBuyQuantity(100_000, 500, 501.01, 5)).toBe(0);
  });

  it.each([null, undefined, 0, -1, NaN, Infinity])('rejects missing or invalid account data and prices: %s', invalid => {
    expect(automaticBuyQuantity(invalid, 1000, 10, 5)).toBe(0);
    expect(automaticBuyQuantity(1000, invalid, 10, 5)).toBe(0);
    expect(automaticBuyQuantity(1000, 1000, invalid, 5)).toBe(0);
  });

  it.each([0, -1, 100.01, NaN, Infinity])('rejects an invalid allocation: %s', allocation => {
    expect(automaticBuyQuantity(1000, 1000, 10, allocation)).toBe(0);
  });
});

describe('automatic buying power', () => {
  const account = { buyingPower: 40_000, cash: 5_000, regtBuyingPower: 20_000 };
  it('uses regular buying power during the regular session', () => {
    expect(automaticBuyingPower(account, false)).toBe(40_000);
  });

  it('uses the lower of Reg T and current buying power outside the regular session', () => {
    expect(automaticBuyingPower(account, true)).toBe(20_000);
    expect(automaticBuyingPower({ ...account, buyingPower: 10_000 }, true)).toBe(10_000);
  });

  it('falls back to nonnegative cash when Reg T is unavailable', () => {
    expect(automaticBuyingPower({ ...account, regtBuyingPower: undefined }, true)).toBe(5_000);
    expect(automaticBuyingPower({ ...account, regtBuyingPower: null, cash: -10 }, true)).toBe(0);
  });

  it('fails closed on invalid balances', () => {
    expect(automaticBuyingPower(null, true)).toBe(0);
    for (const invalid of [NaN, Infinity, -1]) {
      expect(automaticBuyingPower({ ...account, buyingPower: invalid }, false)).toBe(0);
      expect(automaticBuyingPower({ ...account, regtBuyingPower: invalid }, true)).toBe(0);
    }
    expect(automaticBuyingPower({ buyingPower: 1_000, cash: NaN }, true)).toBe(0);
  });
});
