import { isWorkingOrder } from '../core/orders';
import { decimal, numberDecimal, product, units, validateDecimal } from '../core/decimal';
import type { Order, TradeActivity } from '../core/types';
import type { OwnedSnapshot } from '../robots/templates/types';
import type { Run } from './records';

const quantity = (value: number) => units(numberDecimal(value, 9));

/** Strategies use millisecond UTC; retain source precision in broker order/fill evidence. */
export function strategyInstant(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error('A valid broker timestamp is required for strategy supervision. Reconcile the run.');
  }
  return new Date(value).toISOString();
}

export function fillEvidenceComplete(run: Run): boolean {
  return run.orders.every(order => order.filledQty !== null && run.fills.filter(fill => fill.orderId === order.id)
    .reduce((sum, fill) => sum + quantity(fill.qty), 0n) === quantity(order.filledQty));
}

/** Recorded cash and current mark, less reported fees; absent fees are never assumed known. */
export function entryRiskBlock(run: Run, mark: number | null): string | null {
  if (!fillEvidenceComplete(run)) return 'Actual fill costs are incomplete; further entries require reconciliation.';
  if (!run.fills.length) return null;
  if (mark === null || !Number.isFinite(mark) || mark <= 0) return 'A current mark is required for the run loss check.';
  const cash = run.fills.reduce((sum, fill) => sum + product(quantity(fill.qty), units(numberDecimal(fill.price, 12, false)))
    * (fill.side === 'buy' ? -1n : 1n) - (fill.feeUsd == null ? 0n : units(fill.feeUsd)), 0n);
  const marked = product(quantity(ownedInventory(run).quantity!), units(numberDecimal(mark, 12, false)));
  return cash + marked <= -BigInt(run.approved.plan.risk.lossTriggerCents) * units('0.01')
    ? 'Recorded cash and marked inventory reached the approved loss trigger. Unknown fees remain unavailable.' : null;
}

/** A repeated or older observation cannot undo a confirmed fill or terminal state. */
export function observeOrder(orders: readonly Order[], next: Order): Order[] {
  if (next.filledQty === null || !Number.isFinite(next.filledQty) || next.filledQty < 0 ||
      next.qty === null || !Number.isFinite(next.qty) || next.qty <= 0 || next.filledQty > next.qty || !Number.isFinite(Date.parse(next.submittedAt))) {
    throw new Error('Order quantities or timestamps are unavailable. Reconciliation is required.');
  }
  const previous = orders.find(order => order.id === next.id);
  if (previous) {
    if (previous.symbol !== next.symbol || previous.side !== next.side || previous.clientOrderId !== next.clientOrderId || previous.qty !== next.qty
      || previous.parentOrderId && next.parentOrderId && previous.parentOrderId !== next.parentOrderId) {
      throw new Error('Broker order identity changed.');
    }
    if (next.filledQty < (previous.filledQty ?? 0) || !isWorkingOrder(previous.status) && isWorkingOrder(next.status)) {
      if (previous.updatedAt && next.updatedAt && next.updatedAt > previous.updatedAt) throw new Error('Newer broker facts regress confirmed order state.');
      return [...orders];
    }
    if (previous.updatedAt && next.updatedAt && next.updatedAt < previous.updatedAt && next.filledQty === previous.filledQty) return [...orders];
  }
  return [...orders.filter(order => order.id !== next.id), { ...next, ...(previous?.parentOrderId ? { parentOrderId: previous.parentOrderId } : {}) }];
}

export function observeFills(run: Run, activities: readonly TradeActivity[]): TradeActivity[] {
  const fills = new Map(run.fills.map(fill => [fill.id, fill]));
  for (const activity of activities) {
    const order = run.orders.find(order => order.id === activity.orderId);
    if (!order) continue;
    if (order.symbol !== activity.symbol || order.side !== activity.side || !Number.isFinite(Date.parse(activity.transactionTime)) || activity.qty <= 0 || activity.price <= 0) {
      throw new Error('Conflicting attributable fill facts.');
    }
    quantity(activity.qty); numberDecimal(activity.price, 12, false);
    if (activity.feeUsd != null) validateDecimal(activity.feeUsd, 12);
    const prior = fills.get(activity.id);
    if (prior && (prior.orderId !== activity.orderId || prior.qty !== activity.qty || prior.price !== activity.price || prior.transactionTime !== activity.transactionTime)) {
      throw new Error('Broker fill identity changed.');
    }
    fills.set(activity.id, { ...activity, feeUsd: activity.feeUsd ?? prior?.feeUsd });
  }
  return [...fills.values()].sort((a, b) => a.transactionTime.localeCompare(b.transactionTime)
    || (a.side === b.side ? 0 : a.side === 'buy' ? -1 : 1) || a.id.localeCompare(b.id));
}

/** Cumulative broker order fills establish quantity; activities establish actual times/cost. */
export function ownedInventory(run: Run): OwnedSnapshot {
  let net = 0n;
  for (const order of run.orders) {
    if (order.filledQty === null) throw new Error('Confirmed fill quantity is unavailable.');
    net += quantity(order.filledQty) * (order.side === 'buy' ? 1n : -1n);
  }
  if (net < 0n) throw new Error('Attributable inventory is negative.');
  if (net === 0n) return { quantity: 0, positionKey: null, averageEntryPriceUsd: null, entryAt: null, firstFillAt: null };
  const complete = fillEvidenceComplete(run);
  let held = 0n, cost = 0n, first: TradeActivity | null = null;
  if (complete) for (const fill of run.fills) {
    const amount = quantity(fill.qty);
    if (fill.side === 'buy') {
      if (held === 0n) first = fill;
      held += amount; cost += product(amount, units(numberDecimal(fill.price, 12, false)));
    } else {
      if (amount > held) throw new Error('Fill history sells inventory before acquisition.');
      cost = cost * (held - amount) / held; held -= amount;
      if (held === 0n) { first = null; cost = 0n; }
    }
  }
  const amount = Number(decimal(net));
  return { quantity: amount, positionKey: first?.id ?? run.orders.find(order => order.side === 'buy' && order.filledQty! > 0)!.id,
    averageEntryPriceUsd: complete && held === net ? Number(decimal(cost)) / amount : null,
    entryAt: first ? strategyInstant(first.transactionTime) : null, firstFillAt: first ? strategyInstant(first.transactionTime) : null };
}
