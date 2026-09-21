import type { Run } from '../trading/records';
import { unresolved } from '../trading/records';
import { decimal, numberDecimal, product, units, validateDecimal } from '../core/decimal';
import type { ExecutionOutcomeFacts } from '../robots/outcome-facts';

export interface ExactPercentage { readonly numerator: string; readonly denominator: string }
export interface Metric<T = string> { value: T | null; status: 'complete' | 'qualified' | 'unavailable'; reasons: readonly string[] }
const metric = <T>(value: T | null, reasons: string[] = []): Metric<T> => ({ value, status: value === null ? 'unavailable' : reasons.length ? 'qualified' : 'complete', reasons });
const usd = (value: bigint | null, reasons: string[] = []) => metric(value === null ? null : decimal(value), reasons);
const quantity = (value: number) => units(numberDecimal(value, 9));
const price = (value: number) => units(numberDecimal(value, 12, false));
const percent = (value: Metric, denominator: string) => metric(value.value === null ? null : { numerator: decimal(units(value.value) * 100n), denominator }, [...value.reasons]);

/** FIFO: execution time, buys before sells on ties, then broker activity ID.
 * Only actual activities create lots; cumulative order fills cannot invent time/cost. */
export function projectRunMetrics(run: Run, asOf: string, mark: { priceUsd: number; at: string } | null = null) {
  const lots: { quantity: bigint; price: bigint }[] = [];
  let cash = 0n, realized = 0n, held = 0n, fees = 0n, feesKnown = true;
  const reasons: string[] = [];
  const fills = [...run.fills].sort((a, b) => a.transactionTime.localeCompare(b.transactionTime)
    || (a.side === b.side ? 0 : a.side === 'buy' ? -1 : 1) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const seen = new Set<string>();
  for (const fill of fills) {
    if (seen.has(fill.id) || fill.transactionTime > asOf) { reasons.push('conflicting_or_future_fill'); continue; } seen.add(fill.id);
    const amount = quantity(fill.qty), executionPrice = price(fill.price), value = product(amount, executionPrice);
    cash += value * (fill.side === 'buy' ? -1n : 1n);
    if (fill.feeUsd == null) feesKnown = false; else { validateDecimal(fill.feeUsd, 12); fees += units(fill.feeUsd); }
    if (fill.side === 'buy') { held += amount; lots.push({ quantity: amount, price: executionPrice }); }
    else {
      let remaining = amount, basis = 0n;
      for (const lot of lots) {
        const matched = remaining < lot.quantity ? remaining : lot.quantity;
        basis += product(matched, lot.price); lot.quantity -= matched; remaining -= matched;
        if (!remaining) break;
      }
      if (remaining) reasons.push('inventory_deficit');
      realized += value - basis; held -= amount;
    }
  }
  const complete = run.orders.every(order => order.filledQty !== null && quantity(order.filledQty) === fills.filter(fill => fill.orderId === order.id).reduce((sum, fill) => sum + quantity(fill.qty), 0n));
  if (!complete || held < 0n) reasons.push('incomplete_fill_history');
  if (fills.some(fill => !run.orders.some(order => order.id === fill.orderId))) reasons.push('unowned_fill');
  const qualifications = [...(run.blocked ? ['reconciliation_required'] : []), ...(run.commands.some(unresolved) ? ['uncertain_execution'] : [])];
  const valid = !reasons.length;
  const remaining = lots.reduce((sum, lot) => sum + product(lot.quantity, lot.price), 0n);
  const markValid = mark && mark.at <= asOf && Date.parse(asOf) - Date.parse(mark.at) <= 30_000;
  const marked = held === 0n ? 0n : markValid ? product(held, price(mark.priceUsd)) : null;
  const marketReasons = [...reasons, ...qualifications, ...(marked === null ? ['mark_unavailable'] : [])];
  const gross = valid && marked !== null ? cash + marked : null;
  const net = gross !== null && feesKnown ? gross - fees : null;
  const grossTotalPnlUsd = usd(gross, marketReasons), netTotalPnlUsd = usd(net, [...marketReasons, ...(feesKnown ? [] : ['fees_unavailable'])]);
  const ceiling = decimal(BigInt(run.ceilingCents) * units('0.01'));
  const equity = decimal(BigInt(run.approved.plan.capital.equityCents) * units('0.01'));
  return { ownedQuantity: usd(valid ? held : null, [...reasons, ...qualifications]),
    recordedTradeCashFlowUsd: usd(cash, [...reasons, ...qualifications]),
    remainingEntryBasisUsd: usd(valid ? remaining : null, [...reasons, ...qualifications]),
    markedInventoryUsd: usd(valid ? marked : null, marketReasons), grossRealizedPnlUsd: usd(valid ? realized : null, [...reasons, ...qualifications]),
    grossUnrealizedPnlUsd: usd(valid && marked !== null ? marked - remaining : null, marketReasons), grossTotalPnlUsd,
    attributableFeesUsd: usd(valid && feesKnown ? fees : null, [...reasons, ...qualifications, ...(feesKnown ? [] : ['fees_unavailable'])]), netTotalPnlUsd,
    grossReturnOnAllocationPct: percent(grossTotalPnlUsd, ceiling), netReturnOnAllocationPct: percent(netTotalPnlUsd, ceiling),
    netPnlOnSnapshotEquityPct: percent(netTotalPnlUsd, equity),
    capital: { approvedCeilingUsd: ceiling, committedBudgetUsd: usd(run.active ? units(ceiling) : 0n) },
    basis: { fillRefs: fills.map(fill => fill.id), mark, lotConvention: 'fifo-execution-time-buys-first-activity-id' as const } };
}

export function executionOutcomeFacts(run: Run, asOf: string): ExecutionOutcomeFacts {
  const metrics = projectRunMetrics(run, asOf), plan = run.approved.plan;
  const exclusions = [...metrics.netTotalPnlUsd.reasons,
    ...(run.active ? ['run_not_terminated'] : []), ...(run.supervisionInterrupted ? ['interrupted_supervision'] : []),
    ...(run.endedAt && run.endedAt < plan.intendedEnd ? ['ended_before_policy_horizon'] : []),
    ...(run.endedAt && run.endedAt > plan.session.closeAt ? ['missed_session_horizon'] : [])];
  return { scope: { ...run.approved.scope }, proposalId: plan.id, runId: run.id, approvalId: run.approved.id, activationAt: run.approved.approvedAt,
    endedAt: run.endedAt, grossPnlUsd: metrics.grossTotalPnlUsd.value, netPnlUsd: metrics.netTotalPnlUsd.value,
    feesKnown: metrics.attributableFeesUsd.value !== null,
    tradeStatus: metrics.grossTotalPnlUsd.value === null ? 'unknown' : run.fills.length ? 'traded' : 'no_trade', exclusions };
}
