import type { Database } from '../core/database';
import { accountKey } from '../core/account';
import { EXECUTION_CONTRACT, recordKey, type CommandEvidence, type ExecutionStorage, type ManualCommand, type Run } from './records';
import { validateProposal } from '../robots/validation';
import { templates } from '../robots/templates/registry';
import { isWorkingOrder } from '../core/orders';
import { numberDecimal, units, validateDecimal } from '../core/decimal';
import { validateQuantity } from '../core/precision';
import { ownedInventory } from './facts';
import { unresolved } from './records';
import { validateRobotOrder } from './protection';
import { observeManualOrder } from './manual-order';
import type { Order } from '../core/types';

function check(condition: unknown): asserts condition {
  if (!condition) throw new Error('Execution storage is corrupt or incompatible. Retained evidence requires explicit review.');
}
function row(value: unknown): Record<string, unknown> {
  check(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}
const validTime = (value: unknown): boolean => typeof value === 'string' && Number.isFinite(Date.parse(value));
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;
function validateOrder(value: unknown): asserts value is Order {
  const order = row(value);
  check(typeof order.id === 'string' && !!order.id && typeof order.symbol === 'string');
  check(['buy', 'sell'].includes(String(order.side)) && typeof order.type === 'string' && typeof order.status === 'string');
  check(validTime(order.submittedAt));
  for (const key of ['filledAt', 'updatedAt']) check(order[key] == null || validTime(order[key]));
  check(order.qty === null || positive(order.qty));
  check(order.filledQty === null || typeof order.filledQty === 'number' && Number.isFinite(order.filledQty) && order.filledQty >= 0);
  check(order.qty === null || order.filledQty === null || Number(order.filledQty) <= order.qty);
  for (const key of ['filledAvgPrice', 'limitPrice', 'stopPrice']) check(order[key] === undefined || positive(order[key]));
  for (const key of ['timeInForce', 'orderClass', 'parentOrderId']) check(order[key] === undefined || typeof order[key] === 'string');
  check(order.clientOrderId === undefined || typeof order.clientOrderId === 'string');
}
function validateCommand(value: unknown): asserts value is CommandEvidence {
  const command = row(value), action = row(command.action);
  check(typeof command.id === 'string' && command.id.length > 0 && validTime(command.createdAt));
  check(['pending', 'acknowledged', 'rejected', 'uncertain', 'not_sent', 'resolved'].includes(String(command.status)));
  check(command.brokerOrderId === null || typeof command.brokerOrderId === 'string');
  check(command.error === null || typeof command.error === 'string');
  if (action.kind === 'cancel') check(typeof action.orderId === 'string' && typeof action.symbol === 'string');
  else {
    check(action.kind === 'submit');
    const request = row(action.request);
    check(typeof request.symbol === 'string' && /^[A-Z][A-Z0-9.-]{0,14}$/.test(request.symbol));
    check(typeof request.qty === 'number' && Number.isFinite(request.qty) && request.qty > 0);
    validateQuantity(request.qty);
    check(['buy', 'sell'].includes(String(request.side)) && ['market', 'limit', 'stop'].includes(String(request.type)));
    check(typeof request.clientOrderId === 'string' && request.clientOrderId.length > 0);
    if (request.type === 'limit') check(typeof request.limitPrice === 'number' && Number.isFinite(request.limitPrice) && request.limitPrice > 0);
    check(request.extendedHours === undefined || typeof request.extendedHours === 'boolean');
    check(request.timeInForce === undefined || ['day', 'gtc'].includes(String(request.timeInForce)));
    if (request.timeInForce === 'gtc') check(Number.isInteger(request.qty));
    if (request.type === 'stop') check(request.side === 'sell' && ['day', 'gtc'].includes(String(request.timeInForce)) && !request.extendedHours && positive(request.stopPrice));
    if (request.stopLoss !== undefined) check(request.side === 'buy' && ['market', 'limit'].includes(String(request.type))
      && ['day', 'gtc'].includes(String(request.timeInForce)) && Number.isInteger(request.qty) && !request.extendedHours && positive(row(request.stopLoss).stopPrice));
  }
}
export function validateRun(value: unknown, scope: string): asserts value is Run {
  const run = row(value);
  check(run.contract === EXECUTION_CONTRACT && run.scope === scope && typeof run.id === 'string');
  check(run.key === recordKey(scope, run.id) && typeof run.approvalCommandId === 'string');
  check(run.id === `run-${run.approvalCommandId}`);
  check(['running', 'paused', 'closing', 'ended'].includes(String(run.state)) && run.active === (run.state === 'ended' ? 0 : 1));
  check(run.blocked === null || typeof run.blocked === 'string');
  check(typeof run.supervisionInterrupted === 'boolean');
  check(typeof run.exitRequested === 'boolean');
  check(Number.isSafeInteger(run.ceilingCents) && Number(run.ceilingCents) > 0);
  const approved = row(run.approved);
  validateProposal(approved.plan, templates);
  const symbol = approved.plan.symbol, sessionMode = approved.plan.sessionMode;
  check(accountKey(approved.plan.scope) === scope && run.ceilingCents === approved.plan.capital.ceilingCents);
  check(approved.schemaVersion === 1 && approved.commandId === run.approvalCommandId && typeof approved.id === 'string' && validTime(approved.approvedAt));
  check(JSON.stringify(approved.scope) === JSON.stringify(approved.plan.scope));
  check(String(approved.approvedAt) >= approved.plan.generatedAt && String(approved.approvedAt) < approved.plan.validUntil);
  check(run.reconciledAt === null || validTime(run.reconciledAt));
  check(run.endedAt === null || validTime(run.endedAt));
  check((run.state === 'ended') === (run.endedAt !== null));
  const strategy = row(run.strategy);
  check(strategy.schemaVersion === 1 && row(strategy.template).id === approved.plan.template.id && row(strategy.template).version === approved.plan.template.version);
  check(strategy.positionKey === null || typeof strategy.positionKey === 'string');
  check(strategy.firstFillAt === null || validTime(strategy.firstFillAt));
  if (strategy.observedPeak !== null) { const peak = row(strategy.observedPeak); check(positive(peak.priceUsd) && validTime(peak.at)); }
  if (strategy.signal !== null) {
    const signal = row(strategy.signal);
    check(typeof signal.inputRef === 'string' && ['buy', 'sell', 'hold'].includes(String(signal.action))
      && ['no_action', 'pending_submission', 'acknowledged', 'rejected', 'uncertain'].includes(String(signal.disposition)));
  }
  check(Array.isArray(run.commands) && Array.isArray(run.orders) && Array.isArray(run.fills));
  run.commands.forEach(validateCommand);
  check(run.commands.every(command => command.action.kind !== 'submit' || !(command.action.request.stopLoss || command.action.request.type === 'stop')
    || command.action.request.timeInForce === 'gtc'));
  check(run.commands.every(command => command.action.kind !== 'submit' || command.action.request.side !== 'buy' || command.action.request.stopLoss
    || sessionMode === '24x5' && command.action.request.type === 'limit' && command.action.request.extendedHours === true && command.action.request.timeInForce === 'day'));
  check(new Set(run.commands.map(command => command.id)).size === run.commands.length);
  const clients = run.commands.flatMap(command => command.action.kind === 'submit' ? [command.action.request.clientOrderId] : []);
  check(new Set(clients).size === clients.length);
  check(run.commands.every(command => (command.action.kind === 'submit' ? command.action.request.symbol : command.action.symbol) === symbol));
  for (const value of run.orders) {
    validateOrder(value);
    check(value.symbol === approved.plan.symbol && value.filledQty !== null && value.qty !== null);
    validateQuantity(value.filledQty, true); validateQuantity(value.qty);
    validateRobotOrder({ commands: run.commands, orders: run.orders }, value);
  }
  for (const value of run.fills) {
    const fill = row(value);
    check(typeof fill.id === 'string' && typeof fill.orderId === 'string' && fill.symbol === approved.plan.symbol);
    check(['buy', 'sell'].includes(String(fill.side)) && validTime(fill.transactionTime));
    check(typeof fill.qty === 'number' && Number.isFinite(fill.qty) && fill.qty > 0);
    check(typeof fill.price === 'number' && Number.isFinite(fill.price) && fill.price > 0);
    check(typeof fill.type === 'string');
    validateQuantity(fill.qty); numberDecimal(fill.price, 12, false);
    if (fill.feeUsd != null) validateDecimal(fill.feeUsd, 12);
    check(run.orders.some(order => order.id === fill.orderId && order.side === fill.side));
  }
  check(new Set(run.orders.map(order => order.id)).size === run.orders.length && new Set(run.fills.map(fill => fill.id)).size === run.fills.length);
  if (run.latestDecision !== null) {
    const decision = row(run.latestDecision);
    check(typeof decision.reasonCode === 'string' && validTime(decision.evaluatedAt) && validTime(decision.dataCutoff)
      && decision.runId === run.id && Array.isArray(decision.conditions) && Array.isArray(decision.vetoes) && Array.isArray(decision.inputRefs)
      && ['hold', 'request_entry', 'request_exit', 'request_cancel'].includes(String(decision.action)));
    const identity = row(decision.template), policy = row(decision.policy), decisionScope = row(decision.scope);
    check(decision.schemaVersion === 1 && typeof decision.id === 'string'
      && identity.id === approved.plan.template.id && identity.version === approved.plan.template.version
      && policy.id === approved.plan.executionPolicy.id && policy.version === approved.plan.executionPolicy.version
      && decisionScope.broker === approved.plan.scope.broker && decisionScope.environment === approved.plan.scope.environment
      && decisionScope.accountId === approved.plan.scope.accountId && decision.inputRefs.every(value => typeof value === 'string'));
    const scalar = (value: unknown) => typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value);
    for (const value of decision.conditions) {
      const condition = row(value);
      check(typeof condition.code === 'string' && typeof condition.inputRef === 'string' && ['lt', 'lte', 'eq', 'gte', 'gt'].includes(String(condition.operator))
        && scalar(condition.threshold) && (condition.result === 'unavailable' ? condition.observed === null && typeof condition.reason === 'string'
          : ['pass', 'fail'].includes(String(condition.result)) && scalar(condition.observed)));
    }
    for (const value of decision.vetoes) {
      const veto = row(value); check(['portfolio', 'data', 'execution', 'capability', 'session', 'approval'].includes(String(veto.category))
        && typeof veto.code === 'string' && typeof veto.reason === 'string');
    }
    if (decision.candidate !== null) { const candidate = row(decision.candidate); check(['buy', 'sell'].includes(String(candidate.side)) && positive(candidate.quantity)); }
  }
  if (run.state === 'ended') {
    check(!run.commands.some(unresolved) && run.orders.every(order => !isWorkingOrder(order.status)));
    check(run.orders.reduce((qty, order) => qty + (order.side === 'buy' ? 1n : -1n) * units(numberDecimal(order.filledQty!, 9)), 0n) === 0n);
  }
}
function validateManual(value: unknown, scope: string): asserts value is ManualCommand {
  validateCommand(value);
  const command = row(value);
  check(command.contract === EXECUTION_CONTRACT && command.scope === scope && command.key === recordKey(scope, value.id));
  check(Number.isSafeInteger(command.commitmentCents) && Number(command.commitmentCents) >= 0);
  if (command.order !== null) {
    validateOrder(command.order);
    if (value.action.kind === 'submit' && (value.action.request.stopLoss || value.action.request.type === 'stop')) {
      for (const child of command.order.legs ?? []) validateOrder(child);
      observeManualOrder(value.action.request, null, command.order);
    }
  }
  if (value.action.kind === 'submit' && value.action.request.side === 'buy') {
    const order = command.order === null ? null : row(command.order);
    // Older terminal records may retain their original reservation. New observations
    // release it as fills complete or the remaining order becomes terminal.
    if (!['not_sent', 'rejected', 'resolved'].includes(value.status)
      && (!order || isWorkingOrder(String(order.status)) && (order.filledQty === null || order.qty === null
        || Number(order.filledQty) < Number(order.qty)))) check(Number(command.commitmentCents) > 0);
  }
  else check(command.commitmentCents === 0);
  if (command.order !== null) {
    const order = row(command.order);
    check(value.action.kind === 'cancel' ? order.id === value.action.orderId
      : order.symbol === value.action.request.symbol && order.side === value.action.request.side
        && order.clientOrderId === value.action.request.clientOrderId && order.qty === value.action.request.qty);
  }
  if (['acknowledged', 'resolved'].includes(value.status)) check(command.order !== null && value.brokerOrderId === row(command.order).id);
}

/** Each write awaits tx.done: request success is not transaction commit. */
export class ExecutionStore implements ExecutionStorage {
  constructor(private readonly db: Database) {}
  async getActiveRuns(scope: string): Promise<Run[]> {
    // Detect damaged scope/status indexes once at connection without loading terminal history.
    const [keys, scoped, active, ended] = await Promise.all([this.db.countScopeKeys('runs', scope),
      this.db.countFromIndex('runs', 'scope', scope), this.db.countFromIndex('runs', 'active', [scope, 1]), this.db.countFromIndex('runs', 'active', [scope, 0])]);
    check(keys === scoped && scoped === active + ended);
    const values = await this.db.getAllFromIndex('runs', 'active', [scope, 1]);
    return values.map(value => { validateRun(value, scope); return value; });
  }
  async getRunHistory(scope: string): Promise<Run[]> {
    const values = await this.db.getAllFromIndex('runs', 'active', [scope, 0]);
    return values.map(value => { validateRun(value, scope); return value; });
  }
  async getRun(scope: string, id: string): Promise<Run | null> {
    const value = await this.db.get('runs', recordKey(scope, id));
    if (value === undefined) return null;
    validateRun(value, scope); return value;
  }
  async saveRun(run: Run): Promise<void> {
    check(run.contract === EXECUTION_CONTRACT && run.ceilingCents === run.approved.plan.capital.ceilingCents
      && run.scope === accountKey(run.approved.plan.scope) && run.active === (run.state === 'ended' ? 0 : 1));
    if (!run.active) check(ownedInventory(run).quantity === 0 && !run.commands.some(unresolved) && run.orders.every(order => !isWorkingOrder(order.status)));
    await this.db.put('runs', run);
  }
  async getManualCommands(scope: string): Promise<ManualCommand[]> {
    check(await this.db.countScopeKeys('manualCommands', scope) === await this.db.countFromIndex('manualCommands', 'scope', scope));
    const values = await this.db.getAllFromIndex('manualCommands', 'scope', scope);
    return values.map(value => { validateManual(value, scope); return value; });
  }
  async saveManualIntent(command: ManualCommand): Promise<void> {
    validateManual(command, command.scope);
    await this.db.put('manualCommands', command);
  }
}
