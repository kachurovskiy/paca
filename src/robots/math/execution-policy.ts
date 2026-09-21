/** A price actually available to the strategy at a bot cycle. */
export interface PriceObservation { time: number; price: number; }

export const MOMENTUM_EXECUTION_POLICY = {
  stopMode: 'observed-price',
  orderType: 'market',
  cycleIntervalMs: 5000,
} as const;

function positive(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/**
 * Evaluate client-side stops against one observed price, maintaining only
 * observed peaks. Candle extrema never imply that the bot saw those prices.
 * A sell result is market-order intent, not a broker-held protective order or
 * a promise to fill at the stop level. The executor determines the actual fill.
 */
export function evaluateObservedStops(
  parameters: { stopLossPct: number; trailingStopPct: number },
  state: { hasPosition: boolean; entryPrice?: number; peakPrice?: number },
  observation: PriceObservation,
): { peakPrice: number; action: 'sell' | 'hold'; reason: string } {
  if (!state.hasPosition) return { peakPrice: 0, action: 'hold', reason: 'No position to protect' };
  const previousPeak = Math.max(positive(state.entryPrice) ? state.entryPrice : 0, positive(state.peakPrice) ? state.peakPrice : 0);
  if (!positive(observation.price) || !Number.isFinite(observation.time) || !Number.isFinite(new Date(observation.time).getTime())) {
    return { peakPrice: previousPeak, action: 'hold', reason: 'Waiting for a valid price observation' };
  }
  if (!positive(state.entryPrice)) return { peakPrice: previousPeak, action: 'hold', reason: 'Waiting for broker fill cost basis' };
  if (!positive(parameters.stopLossPct) || !positive(parameters.trailingStopPct)) {
    return { peakPrice: previousPeak, action: 'hold', reason: 'Stop parameters are invalid' };
  }
  const peakPrice = Math.max(previousPeak, observation.price);
  if (observation.price <= state.entryPrice * (1 - parameters.stopLossPct / 100)) {
    return { peakPrice, action: 'sell', reason: `Stop loss reached (${parameters.stopLossPct}%)` };
  }
  if (observation.price <= peakPrice * (1 - parameters.trailingStopPct / 100)) {
    return { peakPrice, action: 'sell', reason: `Trailing stop reached (${parameters.trailingStopPct}%)` };
  }
  return { peakPrice, action: 'hold', reason: 'Observed price remains above stops' };
}
