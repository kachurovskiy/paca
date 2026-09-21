import type { Account } from './types';

const MAX_BUY_SHARES = 100_000;

// Shift decimal places through the decimal representation to avoid turning an
// exact tick such as 1.15 into 114.99999999999999 when rounding a sell limit.
function shiftDecimal(value: number, places: number): number {
  const [coefficient, exponent = '0'] = String(value).split('e');
  return Number(`${coefficient}e${Number(exponent) + places}`);
}

/** Use the executable side of a valid quote, rounded out to the allowed tick. */
export function automaticLimitPrice(side: 'buy' | 'sell', bid: number | null | undefined, ask: number | null | undefined): number | null {
  if (bid == null || ask == null || !Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0 || bid > ask) return null;
  const quotePrice = side === 'buy' ? ask : bid;
  const decimals = quotePrice >= 1 ? 2 : 4;
  const ticks = shiftDecimal(quotePrice, decimals);
  const rounded = shiftDecimal(side === 'buy' ? Math.ceil(ticks) : Math.floor(ticks), -decimals);
  return Number.isFinite(rounded) && rounded > 0 ? rounded : null;
}

/** Whole shares within both the selected equity allocation and buying power. */
export function automaticBuyQuantity(equity: number | null | undefined, buyingPower: number | null | undefined, limitPrice: number | null | undefined, allocationPercent: number): number {
  if (equity == null || buyingPower == null || limitPrice == null ||
      ![equity, buyingPower, limitPrice, allocationPercent].every(value => Number.isFinite(value) && value > 0) || allocationPercent > 100) return 0;
  const budget = Math.min(equity * (allocationPercent / 100), buyingPower);
  return Math.min(MAX_BUY_SHARES, Math.floor(budget / limitPrice));
}

/** Keep automatic extended-hours sizing within Regulation T buying power. */
export function automaticBuyingPower(account: Pick<Account, 'buyingPower' | 'cash' | 'regtBuyingPower'> | null, extendedHours: boolean): number {
  if (!account || !Number.isFinite(account.buyingPower) || account.buyingPower < 0) return 0;
  if (!extendedHours) return account.buyingPower;
  const available = account.regtBuyingPower ?? Math.max(0, account.cash);
  return Number.isFinite(available) && available >= 0 ? Math.min(account.buyingPower, available) : 0;
}
