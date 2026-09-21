import { automaticLimitPrice } from '../core/auto-order';
import { executionRulesError } from '../core/orders';
import type { ExecutionQuote } from '../core/quote';
import type { Account, Environment, Order, OrderRequest, Position } from '../core/types';
import { observeOrder } from './facts';

export interface ManualOrder {
  symbol: string;
  side: 'buy' | 'sell';
  type: 'market' | 'limit' | 'stop';
  quantity: number;
  limitPrice?: number;
  stopPrice?: number;
  stopLossPrice?: number;
  timeInForce: 'day' | 'gtc';
  extendedHours: boolean;
}

/** Quote-side first, then latest trade. Used only to prefill an editable field. */
export function suggestedManualLimit(side: 'buy' | 'sell', quote: Pick<ExecutionQuote, 'bid' | 'ask' | 'price'> | null | undefined): number | null {
  const positive = (value: number | null | undefined): value is number => value != null && Number.isFinite(value) && value > 0;
  const sidePrice = side === 'buy' ? quote?.ask : quote?.bid;
  const crossed = positive(quote?.bid) && positive(quote?.ask) && quote.bid > quote.ask;
  const price = !crossed && positive(sidePrice) ? sidePrice : quote?.price;
  return positive(price) ? automaticLimitPrice(side, price, price) : null;
}

export interface ManualPreview {
  request: OrderRequest;
  estimatedValue: number;
  positionQty: number;
  positionAfter: number;
  availableCapital: number | null;
  confirmationReasons: string[];
  error: string | null;
}

export function previewManual(draft: ManualOrder, account: Account | null, position: Position | undefined,
  quote: ExecutionQuote | null, availableCapital: number | null, environment: Environment): ManualPreview {
  const price = draft.type === 'limit' ? draft.limitPrice : draft.type === 'stop' ? draft.stopPrice : quote?.price;
  const quantity = draft.quantity;
  const request: OrderRequest = { symbol: draft.symbol, side: draft.side, qty: quantity,
    type: draft.type, timeInForce: draft.timeInForce, extendedHours: draft.extendedHours,
    ...(draft.type === 'limit' ? { limitPrice: draft.limitPrice } : {}),
    ...(draft.type === 'stop' ? { stopPrice: draft.stopPrice } : {}),
    ...(draft.stopLossPrice !== undefined ? { stopLoss: { stopPrice: draft.stopLossPrice } } : {}) };
  const estimatedValue = quantity * (price ?? NaN), positionQty = position?.qty ?? 0;
  const confirmationReasons: string[] = [];
  if (draft.side === 'sell' && positionQty > 0 && quantity === positionQty) confirmationReasons.push(draft.type === 'stop'
    ? 'This sells your entire holding if the stop triggers.' : 'This closes your entire holding.');
  if (environment === 'live' && Number.isFinite(estimatedValue)) {
    if (estimatedValue >= 10_000) confirmationReasons.push('This live order is estimated at $10,000 or more.');
    if (account && account.equity > 0 && estimatedValue >= account.equity * .25) confirmationReasons.push('This live order uses at least 25% of account equity.');
  }
  const currentPrice = quote?.price;
  const stopError = draft.type === 'stop' || draft.stopLossPrice !== undefined
    ? currentPrice == null || !Number.isFinite(currentPrice) || currentPrice <= 0 ? 'A current market price is required to validate the stop.'
      : draft.type === 'stop' ? draft.stopPrice! >= currentPrice ? 'Sell stop must be below the current market price.' : null
        : currentPrice - draft.stopLossPrice! < 0.01 - 1e-9 ? 'Stop loss must be at least $0.01 below the current market price.' : null
    : null;
  const error = !account || availableCapital === null ? 'Account balances are unavailable.'
    : position && position.side !== 'long' ? 'Short selling is not supported.'
    : !['market', 'limit', 'stop'].includes(draft.type) ? 'Choose a market, limit or stop order.'
    : !['day', 'gtc'].includes(draft.timeInForce) || typeof draft.extendedHours !== 'boolean' ? 'Choose an order duration and permitted trading sessions.'
    : executionRulesError(request) ?? stopError
      ?? (!price || !Number.isFinite(price) || price <= 0 ? 'A valid order price is required.'
        : !Number.isFinite(quantity) || quantity <= 0 || quantity > (draft.side === 'sell' && quantity === positionQty ? 1e9 : 100_000)
          || !(Number.isInteger(quantity) || draft.side === 'sell' && quantity === positionQty) ? 'Use whole shares or sell the full fractional remainder.'
          : draft.side === 'buy' ? estimatedValue > availableCapital ? 'Insufficient available capital after Paca reservations.' : null
            : quantity > positionQty ? 'Insufficient confirmed long inventory.' : null);
  return { request, estimatedValue, positionQty, positionAfter: positionQty + (draft.side === 'buy' ? quantity : -quantity),
    availableCapital, confirmationReasons, error };
}

/** Reconcile the manual entry and its broker-held stop without adopting Robot ownership. */
export function observeManualOrder(request: OrderRequest, previous: Order | null, next: Order): Order {
  if (next.type !== request.type || request.type === 'limit' && next.limitPrice !== request.limitPrice
    || (request.type === 'stop' || request.stopLoss) && next.timeInForce !== request.timeInForce
    || request.type === 'stop' && next.stopPrice !== request.stopPrice) throw new Error('Broker order does not match its recorded execution rules.');
  let observed = observeOrder(previous ? [previous] : [], next)[0];
  if (request.stopLoss) {
    const child = next.legs?.[0], prior = previous?.legs?.[0];
    if (next.orderClass !== 'oto' || next.legs?.length !== 1 || !child || child.id === next.id || child.parentOrderId !== next.id
      || child.symbol !== next.symbol || child.side !== 'sell' || child.type !== 'stop' || child.qty !== request.qty
      || child.timeInForce !== request.timeInForce || child.stopPrice !== request.stopLoss.stopPrice || child.legs?.length
      || prior && prior.id !== child.id) throw new Error('Attached broker stop is unconfirmed or changed. Reconcile the original order; do not resubmit.');
    observed = { ...observed, legs: observeOrder(prior ? [prior] : [], child) };
  }
  return observed;
}

/** Bind a review to the actual order and consequences, never just a generic yes/no. */
export function manualReviewKey(preview: ManualPreview): string {
  // A market order authorizes a variable fill price; a moving estimate alone must
  // not cause another confirmation unless it crosses a consequential threshold.
  return JSON.stringify([preview.request, preview.positionQty, preview.confirmationReasons]);
}

export class ManualReviewRequired extends Error {
  constructor(readonly preview: ManualPreview) {
    super('Review the current order details before submitting.');
  }
}
