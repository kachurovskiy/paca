import { automaticBuyingPower } from '../core/auto-order';
import { isWorkingOrder } from '../core/orders';
import type { Account } from '../core/types';
import { unresolved, type ManualCommand, type Run } from './records';

/** The same conservative reservation policy is used by the ticket and execution queue. */
export function capitalAvailable(account: Account, runs: readonly Run[], manual: readonly ManualCommand[], extendedHours = false, ownRunId?: string) {
  const reservedCents = runs.filter(run => run.active && run.id !== ownRunId).reduce((sum, run) => sum + run.ceilingCents, 0)
    + manual.filter(command => unresolved(command) || command.status === 'acknowledged' && (!command.order || isWorkingOrder(command.order.status)))
      .reduce((sum, command) => sum + command.commitmentCents, 0);
  // Broker buying power may already include commitments; retain Paca's conservative deduction.
  const ceiling = Math.min(account.equity, automaticBuyingPower(account, extendedHours));
  return { reservedCents, availableCents: Math.max(0, Math.floor(ceiling * 100) - reservedCents) };
}
