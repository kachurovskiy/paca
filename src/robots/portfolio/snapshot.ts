import type { Account, Order, Position } from '../../core/types';
import { isWorkingOrder } from '../../core/orders';
import { numberDecimal, units } from '../../core/decimal';
import type { AccountScope } from '../../core/account';
import type { Veto } from '../domain';
import { integer, requireValue } from '../../core/validation';
import { validateScope } from '../validation';

export interface PortfolioInput {
  readonly id: string; readonly scope: AccountScope; readonly asOf: string; readonly validUntil: string;
  readonly brokerSourceRef: string; readonly localSourceRef: string;
  readonly complete: { readonly broker: boolean; readonly local: boolean; readonly reconciliation: boolean };
  readonly account: Account; readonly positions: readonly Position[]; readonly orders: readonly Order[];
  readonly commitments: readonly { readonly symbol: string; readonly ceilingCents: number }[];
  readonly uncertain: boolean;
}
export interface PortfolioSnapshot {
  readonly id: string; readonly scope: AccountScope; readonly asOf: string; readonly validUntil: string;
  readonly blocks: readonly Veto[]; readonly equityCents: number | null; readonly symbolClaims: readonly string[];
  readonly totals: { readonly aggregateExposureCents: number; readonly availableBuyingPowerCents: number } | null;
}
export const portfolioBlock = (code: string, reason: string): Veto => ({ category: 'portfolio', code, reason });
export const money = (value: number): bigint => units(numberDecimal(value, 12));
export function cents(value: bigint, round: 'up' | 'down'): number {
  requireValue(value >= 0n, 'money', 'negative_amount'); const cent = units('0.01');
  const result = value / cent + (round === 'up' && value % cent ? 1n : 0n);
  requireValue(result <= BigInt(Number.MAX_SAFE_INTEGER), 'money', 'unsafe_amount'); return Number(result);
}
export function normalizePortfolio(input: PortfolioInput): PortfolioSnapshot {
  validateScope(input.scope);
  const blocks: Veto[] = [];
  let equityCents: number | null = null, totals: PortfolioSnapshot['totals'] = null;
  const symbolClaims = [...new Set([...input.positions.filter(position => position.qty !== 0).map(position => position.symbol),
    ...input.orders.filter(order => isWorkingOrder(order.status)).map(order => order.symbol), ...input.commitments.map(value => value.symbol)])];
  try {
    requireValue(Object.values(input.complete).every(Boolean) && !input.uncertain, 'portfolio', 'reconciliation_required');
    requireValue(!input.account.tradingBlocked && input.account.id === input.scope.accountId, 'account', 'unavailable');
    equityCents = cents(money(input.account.equity), 'down');
    let external = 0;
    for (const position of input.positions) {
      requireValue(position.side === 'long' && position.marketValue !== null && position.marketValue >= 0, 'position', 'unavailable');
      external += cents(money(position.marketValue), 'up');
    }
    let committed = 0;
    for (const order of input.orders.filter(order => isWorkingOrder(order.status) && order.side === 'buy')) {
      requireValue(order.qty !== null && order.filledQty !== null && order.limitPrice != null && order.limitPrice > 0, 'order', 'open_order_commitment_unavailable');
      committed += cents(money(Math.max(0, order.qty! - order.filledQty!) * order.limitPrice!), 'up');
    }
    for (const value of input.commitments) { integer(value.ceilingCents, 'ceiling'); committed += value.ceilingCents; }
    totals = { aggregateExposureCents: external + committed, availableBuyingPowerCents: Math.max(0, cents(money(Math.min(input.account.cash, input.account.equity, input.account.buyingPower)), 'down') - committed) };
  } catch (error) { blocks.push(portfolioBlock('portfolio_unavailable', error instanceof Error ? error.message : 'Portfolio facts are unavailable.')); }
  return { id: input.id, scope: input.scope, asOf: input.asOf, validUntil: input.validUntil, blocks, equityCents, totals, symbolClaims };
}
