/** Legacy Wick price calculation; keep its rounding semantics unchanged. */
export function wickLimitPrice(bid: number, dipPct: number): number {
  if (![bid, dipPct].every(Number.isFinite) || bid <= 0 || dipPct <= 0 || dipPct > 20) return 0;
  const price = bid * (1 - dipPct / 100), scale = price >= 1 ? 100 : 10000;
  return Math.floor(price * scale) / scale;
}
