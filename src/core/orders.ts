import type { OrderRequest } from './types';

/** Unknown broker states are working, never evidence of completion. */
export const isWorkingOrder = (status: string): boolean =>
  !['filled', 'canceled', 'expired', 'rejected', 'replaced'].includes(status);

/** Alpaca US equity ticks: cents at $1 and above, ten-thousandths below $1. */
export function limitPriceError(price: number | undefined): string | null {
  if (price === undefined || !Number.isFinite(price) || price <= 0) return 'Enter a positive limit price.';
  return Number(price.toFixed(price >= 1 ? 2 : 4)) === price ? null
    : price >= 1 ? 'Limit prices at $1 or above must use $0.01 increments.' : 'Limit prices below $1 must use $0.0001 increments.';
}

export function stopPriceError(price: number | undefined): string | null {
  return limitPriceError(price)?.replaceAll('limit', 'stop').replaceAll('Limit', 'Stop') ?? null;
}

export function executionRulesError(order: OrderRequest): string | null {
  if (order.timeInForce !== undefined && !['day', 'gtc'].includes(order.timeInForce)) return 'Unsupported order duration.';
  if (order.extendedHours && order.type !== 'limit') return 'Extended-hours trading requires a limit order.';
  if (order.timeInForce === 'gtc' && !Number.isInteger(order.qty)) return 'GTC orders require whole shares. Choose Day for a fractional close.';
  if (order.type === 'limit') { const error = limitPriceError(order.limitPrice); if (error) return error; }
  if (order.type === 'stop') {
    const error = order.side !== 'sell' ? 'Stop orders are available for selling holdings.' : stopPriceError(order.stopPrice);
    if (error) return error;
  }
  if (order.stopLoss) {
    if (order.side !== 'buy' || !['market', 'limit'].includes(order.type)) return 'A stop loss can only be attached to a market or limit buy.';
    if (order.extendedHours) return 'Buys with a stop loss require regular hours only.';
    if (!Number.isInteger(order.qty)) return 'Buys with a stop loss require whole shares.';
    const error = stopPriceError(order.stopLoss.stopPrice); if (error) return error;
    if (order.type === 'limit' && order.limitPrice! - order.stopLoss.stopPrice < 0.01 - 1e-9) return 'Stop loss must be at least $0.01 below the buy limit.';
  }
  return null;
}
