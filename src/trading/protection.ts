import type { Order } from '../core/types';
import { isWorkingOrder } from '../core/orders';
import { numberDecimal, units } from '../core/decimal';
import type { RobotProposal } from '../robots/domain';
import type { Run } from './records';
import { unresolved } from './records';
import { observeOrder, ownedInventory } from './facts';

function requireProtection(valid: unknown, reason: string): asserts valid { if (!valid) throw new Error(reason); }

/** A fixed broker backup uses the tighter of the approved stop and run loss trigger.
 * It is based on the entry reference, not an assumed future fill price. */
export function backupStopPrice(plan: RobotProposal, reference: number, qty: number, marketPrice: number): number {
  requireProtection(Number.isInteger(qty) && qty > 0, 'Broker GTC protection requires whole shares. Close a fractional remainder explicitly.');
  requireProtection(Number.isFinite(reference) && reference > 0 && Number.isFinite(marketPrice) && marketPrice > 0, 'A current price and entry reference are required for protection.');
  const percent = plan.parameters.stopLossPct;
  const raw = Math.max(reference - plan.risk.lossTriggerCents / 100 / qty,
    typeof percent === 'number' ? reference * (1 - percent / 100) : 0);
  const scale = raw >= 1 ? 100 : 10000;
  const price = Math.floor(raw * scale + 1e-9) / scale;
  requireProtection(price > 0 && price <= Math.min(reference, marketPrice) - 0.01 + 1e-9,
    'The approved backup stop cannot be placed below the current price. Close the position or review a new plan.');
  return price;
}

export const isProtectionOrder = (order: Order): boolean => order.side === 'sell' && order.type === 'stop' && order.timeInForce === 'gtc';

/** Broker observations and stored orders obey the same protected-entry contract. */
export function validateRobotOrder(run: Pick<Run, 'commands' | 'orders'>, next: Order): Order {
  const parentId = next.parentOrderId ?? run.orders.find(order => order.id === next.id)?.parentOrderId;
  const parent = parentId ? run.orders.find(order => order.id === parentId) : next;
  const command = parent && run.commands.find(command => command.action.kind === 'submit' && command.action.request.clientOrderId === parent.clientOrderId);
  requireProtection(parent && command?.action.kind === 'submit', 'Unattributed broker order requires reconciliation.');
  const request = command.action.request;
  requireProtection(parent.symbol === request.symbol && parent.side === request.side && parent.qty === request.qty && parent.type === request.type
    && (request.type !== 'limit' || parent.limitPrice === request.limitPrice), 'Broker order does not match its recorded request.');
  if (request.side === 'buy') requireProtection(request.stopLoss ? parent.orderClass === 'oto' && parent.timeInForce === 'gtc'
    : request.type === 'limit' && request.extendedHours === true && request.timeInForce === 'day' && (!parent.orderClass || parent.orderClass === 'simple') && parent.extendedHours === true && parent.timeInForce === 'day',
    'Robot entries require a recorded broker-held stop.');
  if (parentId) {
    requireProtection(request.stopLoss && parent.side === 'buy' && next.id !== parentId && next.symbol === parent.symbol
      && isProtectionOrder(next) && next.qty === parent.qty && next.stopPrice === request.stopLoss.stopPrice && !next.legs?.length,
      'The broker stop does not match the recorded protected entry. Reconcile in Alpaca.');
    return { ...next, parentOrderId: parentId };
  }
  if (request.type === 'stop') requireProtection(isProtectionOrder(next) && next.stopPrice === request.stopPrice,
    'The broker stop changed from its recorded request. Review it in Alpaca.');
  return next;
}

/** Only the single nested stop of a recorded entry may become an owned child. */
export function observeRobotOrder(run: Pick<Run, 'commands' | 'orders'>, next: Order): Order[] {
  const { legs, ...parent } = next;
  let orders = observeOrder(run.orders, validateRobotOrder(run, parent));
  if (next.side === 'buy' && run.commands.some(command => command.action.kind === 'submit' && command.action.request.clientOrderId === next.clientOrderId && command.action.request.stopLoss)) {
    requireProtection(legs?.length === 1 && legs[0].parentOrderId === next.id && !legs[0].legs?.length,
      'Attached broker stop is unconfirmed. Reconcile the original entry in Alpaca; do not resubmit.');
    const { legs: _nested, ...child } = legs[0];
    requireProtection(!orders.some(order => order.id === child.id && order.parentOrderId !== next.id), 'Conflicting attached order identity.');
    orders = observeOrder(orders, validateRobotOrder({ ...run, orders }, child));
  } else requireProtection(!legs?.length, 'Unexpected attached orders require reconciliation.');
  return orders;
}

export interface ProtectionStatus { state: 'active' | 'pending' | 'unprotected' | 'unknown' | 'flat' | 'exiting'; message: string }
export function protectionStatus(run: Run): ProtectionStatus {
  const qty = ownedInventory(run).quantity!;
  const stops = run.orders.filter(order => isProtectionOrder(order) && isWorkingOrder(order.status));
  if (run.blocked || run.commands.some(unresolved)) return { state: 'unknown', message: 'Broker protection needs reconciliation.' };
  if (run.exitRequested || run.state === 'closing') return { state: 'exiting', message: 'Exit in progress. Canceling the stop creates a protection gap until the sell fills; keep the browser open.' };
  if (qty === 0) return run.orders.some(order => isWorkingOrder(order.status))
    ? { state: 'pending', message: run.approved.plan.sessionMode === '24x5' ? 'Entry pending. Extended-hours fills need browser supervision until a separate backup stop is confirmed; stops execute only in regular hours.' : 'Entry pending. Attached stop activates only after the entry fills completely.' }
    : { state: 'flat', message: 'No Robot inventory.' };
  const active = stops.filter(order => ['new', 'partially_filled'].includes(order.status));
  const quantity = (value: number) => units(numberDecimal(value, 9));
  const covered = active.reduce((sum, order) => sum + quantity(order.qty!) - quantity(order.filledQty!), 0n);
  if (covered === quantity(qty)) return { state: 'active', message: `Broker-held GTC stop covers ${qty} shares at ${active.map(order => `$${order.stopPrice}`).join(', ')} (last reconciled ${run.reconciledAt ?? 'unknown'}).` };
  if (stops.length) return { state: 'pending', message: 'Stop is not confirmed active for all held shares. Partial entries remain exposed until full fill; keep supervising.' };
  return { state: 'unprotected', message: 'No working broker stop for this position. Attach protection or Close; use Alpaca if this connection is unavailable.' };
}
