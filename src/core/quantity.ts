const MAX_ORDER_SHARES = 100_000;

/** Round down to whole shares, using clean increments for larger positions. */
function roundShares(shares: number): number {
  const step = shares < 10 ? 1 : shares < 100 ? 5 : 10 ** Math.floor(Math.log10(shares)) / 4;
  return Math.floor(shares / step) * step;
}

export function portfolioQuantityPresets({ side, equity, buyingPower, price, holdings }: {
  side: 'buy' | 'sell'; equity?: number; buyingPower?: number; price?: number | null; holdings?: number;
}): number[] {
  if (side === 'sell') {
    if (!Number.isFinite(holdings) || !holdings || holdings < 1) return [];
    const available = Math.min(MAX_ORDER_SHARES, Math.floor(holdings));
    return [...new Set([0.25, 0.5, 0.75, 1].map(fraction => fraction === 1 ? available : roundShares(available * fraction)).filter(qty => qty > 0))];
  }
  if (!equity || !buyingPower || !price || ![equity, buyingPower, price].every(value => Number.isFinite(value) && value > 0)) return [];
  const affordable = Math.min(MAX_ORDER_SHARES, Math.floor(buyingPower / price));
  return [...new Set([0.05, 0.1, 0.25, 0.5].map(fraction => {
    const target = Math.min(affordable, equity * fraction / price);
    const rounded = roundShares(target);
    // Expensive shares may exceed a target allocation; offer one only if it
    // fits both the account's equity and available buying power.
    return rounded || (affordable >= 1 && equity >= price ? 1 : 0);
  }).filter(qty => qty > 0))];
}
