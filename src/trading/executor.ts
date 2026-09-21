import type { AccountReads, BrokerMutations } from '../broker/capabilities';
import { BrokerWriteError } from '../broker/capabilities';
import { isWorkingOrder } from '../core/orders';
import { validateProposal } from '../robots/validation';
import type { RobotProposal } from '../robots/domain';
import { initialTemplateState } from '../robots/templates/common';
import { evaluateTemplate, templates } from '../robots/templates/registry';
import { tradingSession } from '../core/trading-session';
import type { AccountObservation, Order, OrderRequest, TradeActivity } from '../core/types';
import { entryRiskBlock, observeFills, observeOrder, ownedInventory, strategyInstant } from './facts';
import { automaticLimitPrice } from '../core/auto-order';
import { MarketDataUnavailableError } from '../core/market-data';
import { backupStopPrice, isProtectionOrder, observeRobotOrder } from './protection';
import { freshQuote, type ExecutionMarket } from './market';
import { AccountOwnership } from './ownership';
import { accountKey } from '../core/account';
import { EXECUTION_CONTRACT, recordKey, unresolved, type CommandAction, type CommandEvidence, type ExecutionStorage, type ManualCommand, type Run } from './records';
import { capitalAvailable } from './capital';
import { manualReviewKey, ManualReviewRequired, observeManualOrder, previewManual, type ManualOrder } from './manual-order';
export type { ManualOrder } from './manual-order';

type Facts = AccountObservation;
export interface TradingModel { runs: readonly Run[]; manual: readonly ManualCommand[]; hold: string | null; liveArmed: boolean; liveRobotsArmed: boolean;
  observation: AccountObservation | null; reconciliationError: string | null }
const message = (error: unknown): string => error instanceof Error ? error.message : 'Execution failed.';
const iso = (time: number): string => new Date(time).toISOString();
const requireFact = (value: unknown, reason: string): void => { if (!value) throw new Error(reason); };

function unchangedRun(before: Run, after: Run): boolean {
  if (before.state !== after.state || before.blocked !== after.blocked || before.active !== after.active || before.endedAt !== after.endedAt
    || before.supervisionInterrupted !== after.supervisionInterrupted || before.exitRequested !== after.exitRequested) return false;
  const decision = (run: Run) => run.latestDecision && { action: run.latestDecision.action, reason: run.latestDecision.reasonCode,
    candidate: run.latestDecision.candidate, vetoes: run.latestDecision.vetoes,
    conditions: run.latestDecision.conditions.map(({ inputRef: _source, ...condition }) => condition) };
  // Compare only material aggregate facts. Observation IDs/times alone do not write storage.
  return JSON.stringify([before.strategy, before.commands, before.orders, before.fills, decision(before)])
    === JSON.stringify([after.strategy, after.commands, after.orders, after.fills, decision(after)]);
}

/** The sole execution authority. Every public command uses this one account queue. */
export class Trading {
  private tail: Promise<unknown> = Promise.resolve();
  private disposed = false;
  private tickPending = false;
  private runs = new Map<string, Run>();
  private pulses = new Map<string, number>();
  private manual = new Map<string, ManualCommand>();
  private hold: string | null = null;
  private observation: AccountObservation | null = null;
  private reconciliationError: string | null = null;
  private armed = false;
  private robotsArmed = false;
  private robotArmingGeneration = 0;
  private listeners = new Set<() => void>();
  private snapshot: TradingModel = { runs: [], manual: [], hold: null, liveArmed: false, liveRobotsArmed: false, observation: null, reconciliationError: null };
  readonly scope: string;

  constructor(private readonly owner: AccountOwnership, private readonly reads: AccountReads,
    private readonly writes: BrokerMutations, private readonly market: ExecutionMarket,
    private readonly storage: ExecutionStorage, private readonly now: () => number = Date.now) {
    this.scope = accountKey(owner.scope);
  }
  get model(): TradingModel { return this.snapshot; }
  allocationSnapshot() {
    return { uncertain: this.disposed || !!this.hold || this.ambiguous(),
      commitments: [...this.runs.values()].filter(run => run.active).map(run => ({ symbol: run.approved.plan.symbol, ceilingCents: run.ceilingCents })) };
  }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private publish(): void {
    if (this.disposed) return;
    // Detached publications cannot mutate the private approved plans or command evidence.
    this.snapshot = { runs: structuredClone([...this.runs.values()]), manual: structuredClone([...this.manual.values()]), hold: this.hold, liveArmed: this.armed, liveRobotsArmed: this.robotsArmed,
      observation: structuredClone(this.observation), reconciliationError: this.reconciliationError };
    for (const listener of this.listeners) listener();
  }
  private assert(): void { requireFact(!this.disposed, 'This account session is closed.'); this.owner.assert(); }
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    try { this.assert(); } catch (error) { return Promise.reject(error); }
    const task = this.tail.then(() => { this.assert(); return work(); });
    this.tail = task.catch(() => {});
    return task.then(value => structuredClone(value));
  }
  private ready(): void { this.assert(); requireFact(!this.hold, this.hold ?? 'Execution is held.'); }

  initialize(): Promise<void> {
    return this.enqueue(async () => {
      try {
        const [runs, manual] = await Promise.all([this.storage.getActiveRuns(this.scope), this.storage.getManualCommands(this.scope)]);
        this.assert();
        this.manual = new Map(manual.map(command => [command.id, command]));
        for (const saved of runs) {
          const run: Run = { ...saved, state: 'paused', supervisionInterrupted: true, blocked: 'Reopened run: reconcile, then explicitly Resume or Close.' };
          await this.save(run);
        }
      } catch (error) { this.hold = message(error); }
      this.publish();
    });
  }
  armLive(armed: boolean): Promise<void> {
    return this.enqueue(async () => { this.armed = this.owner.scope.environment === 'live' && armed; this.publish(); });
  }
  armLiveRobots(armed: boolean): Promise<void> {
    const generation = ++this.robotArmingGeneration;
    // Disarming fences an entry even while its pre-write reads or intent commit are pending.
    if (!armed) { this.robotsArmed = false; this.publish(); }
    return this.enqueue(async () => {
      if (generation !== this.robotArmingGeneration) return;
      this.robotsArmed = this.owner.scope.environment === 'live' && armed; this.publish();
    });
  }
  private robotEntriesAllowed(): boolean { return this.owner.scope.environment === 'paper' || this.robotsArmed; }
  /** Fence synchronously; already-sent writes retain their original store and lock until settled. */
  async dispose(): Promise<void> {
    this.disposed = true; this.armed = false; this.robotsArmed = false; this.listeners.clear();
    await this.tail; await this.owner.release();
  }
  private async save(run: Run): Promise<void> {
    const prior = this.runs.get(run.id);
    if (prior && unchangedRun(prior, run)) { this.runs.set(run.id, run); return; }
    try { await this.storage.saveRun(run); this.runs.set(run.id, run); }
    catch (error) { this.hold = `Execution storage failed: ${message(error)}`; this.publish(); throw error; }
    this.publish();
  }
  private async saveManual(command: ManualCommand): Promise<void> {
    if (JSON.stringify(this.manual.get(command.id)) === JSON.stringify(command)) return;
    try { await this.storage.saveManualIntent(command); this.manual.set(command.id, command); }
    catch (error) { this.hold = `Execution storage failed: ${message(error)}`; this.publish(); throw error; }
    this.publish();
  }
  private async facts(): Promise<Facts> {
    const at = this.now();
    const [account, positions, orders, clock] = await Promise.all([
      this.reads.getAccount(), this.reads.getPositions(), this.reads.getOrders(), this.reads.getClock(),
    ]);
    this.assert();
    requireFact(account.id === this.owner.scope.accountId, 'The broker account identity changed. Reconnect.');
    requireFact(this.now() - at <= 15_000, 'Account observations became stale.');
    return { account, positions, orders, clock, at };
  }
  private ambiguous(except?: string): boolean {
    const pending = (command: CommandEvidence) => command.id !== except && unresolved(command);
    return [...this.manual.values()].some(pending) || [...this.runs.values()].some(run => run.active && run.commands.some(pending));
  }
  private claims(symbol: string): Run | undefined { return [...this.runs.values()].find(run => run.active && run.approved.plan.symbol === symbol); }
  private remainingCapital(facts: Facts, ownRun?: Run): number {
    return capitalAvailable(facts.account, [...this.runs.values()], [...this.manual.values()], tradingSession(facts.clock, this.now()) !== 'regular', ownRun?.id).availableCents;
  }
  private sessionGate(facts: Facts, request: OrderRequest, robot: boolean): void {
    this.ready();
    if (robot && !this.market.ready()) throw new MarketDataUnavailableError('Waiting for the real-time market feed.');
    requireFact(!facts.account.tradingBlocked && this.market.ready(), 'A current account and real-time feed are required.');
    requireFact(this.owner.scope.environment !== 'live' || (robot ? request.side === 'sell' || this.robotsArmed : this.armed),
      robot ? 'Enable live Robot entries for this connection first.' : 'Live manual trading must be explicitly armed.');
    requireFact(this.now() - facts.at <= 15_000, 'Account observations became stale.');
    const session = tradingSession(facts.clock, this.now());
    if (robot && ['weekend', 'unavailable'].includes(session)) throw new MarketDataUnavailableError('Waiting for an open trading session.');
    requireFact(!request.extendedHours && !(robot && request.type === 'stop') ? session === 'regular' : ['regular', 'extended', 'overnight'].includes(session), 'The selected trading session is closed.');
    const fresh = freshQuote(this.market.quote(request.symbol), this.now(), request.type === 'stop' ? 'market' : request.type, robot);
    if (robot && !fresh) throw new MarketDataUnavailableError('Waiting for a fresh price and quote.');
    requireFact(fresh, 'A fresh price and the required quote/feed are unavailable.');
    if (request.stopLoss) requireFact(freshQuote(this.market.quote(request.symbol), this.now(), 'market'), 'A fresh market price is required for the stop loss.');
  }
  private command(id: string, action: CommandAction): CommandEvidence {
    requireFact(/^[A-Za-z0-9_-]{1,38}$/.test(id), 'Invalid command identity.');
    return { id, createdAt: iso(this.now()), action, status: 'pending', brokerOrderId: null, error: null };
  }

  approve(commandId: string, proposal: RobotProposal): Promise<Run> {
    const frozen = structuredClone(proposal);
    return this.enqueue(async () => {
      this.ready();
      const id = `run-${commandId}`;
      const prior = this.runs.get(id) ?? await this.storage.getRun(this.scope, id);
      if (prior) return prior;
      this.command(commandId, { kind: 'cancel', orderId: 'identity-validation', symbol: frozen.symbol });
      requireFact(accountKey(frozen.scope) === this.scope, 'The plan must belong to this account and environment.');
      requireFact(this.robotEntriesAllowed(), 'Enable live Robot entries for this connection first.');
      requireFact(!this.ambiguous(), 'Reconcile uncertain account commands before approving a run.');
      requireFact(!this.claims(frozen.symbol), 'An active run already claims this symbol.');
      const facts = await this.facts();
      requireFact(!facts.positions.some(position => position.symbol === frozen.symbol && position.qty !== 0)
        && !facts.orders.some(order => order.symbol === frozen.symbol && isWorkingOrder(order.status)), 'This symbol has external inventory or orders. Resolve them explicitly.');
      requireFact(frozen.capital.ceilingCents <= Math.min(this.remainingCapital(facts), facts.account.cash * 100), 'The full capital ceiling is unavailable.');
      validateProposal(frozen, templates);
      requireFact(frozen.generatedAt <= iso(this.now()) && iso(this.now()) < frozen.validUntil, 'The reviewed plan has expired.');
      const approved = { schemaVersion: 1 as const, scope: frozen.scope, id: `approval-${commandId}`, commandId, approvedAt: iso(this.now()), plan: frozen };
      const market = await this.market.snapshot(frozen);
      requireFact(market.session?.openAt === frozen.session.openAt && market.session.closeAt === frozen.session.closeAt
        && market.session.tradingDate === frozen.session.tradingDate, 'The frozen calendar session changed.');
      requireFact(!frozen.blocks.length && this.now() >= Date.parse(frozen.entryWindow.from) && this.now() < Date.parse(frozen.entryWindow.to), 'The frozen plan is blocked or outside its entry window.');
      this.sessionGate(facts, { symbol: frozen.symbol, side: 'buy', qty: 1, type: frozen.sessionMode === '24x5' ? 'limit' : 'market', extendedHours: frozen.sessionMode === '24x5' }, true);
      const run: Run = { key: recordKey(this.scope, id), scope: this.scope, contract: EXECUTION_CONTRACT,
        id, approvalCommandId: commandId, active: 1, state: 'running', blocked: null, supervisionInterrupted: false, exitRequested: false, approved,
        ceilingCents: frozen.capital.ceilingCents, strategy: initialTemplateState(frozen.template),
        orders: [], fills: [], commands: [], latestDecision: null, reconciledAt: iso(this.now()), endedAt: null };
      this.pulses.set(id, this.now()); await this.save(run); return run;
    });
  }
  submitManual(id: string, draft: ManualOrder, review?: { key: string; confirmed: boolean }): Promise<ManualCommand> {
    const captured = { ...draft };
    const authorization = review && { ...review };
    return this.enqueue(async () => {
      this.ready();
      const prior = this.manual.get(id); if (prior) return prior;
      requireFact(!this.ambiguous(), 'Reconcile uncertain commands before submitting another order.');
      requireFact(!this.claims(captured.symbol), 'An active Robot claims this symbol. Close and reconcile the run first.');
      const facts = await this.facts(), quote = this.market.quote(captured.symbol);
      const position = facts.positions.find(position => position.symbol === captured.symbol);
      requireFact(!position || position.side === 'long', 'Short selling is not supported.');
      requireFact(!facts.orders.some(order => order.symbol === captured.symbol && isWorkingOrder(order.status)), 'Resolve this symbol’s existing order first.');
      const capital = capitalAvailable(facts.account, [...this.runs.values()], [...this.manual.values()], captured.extendedHours);
      const preview = previewManual(captured, facts.account, position, quote, capital.availableCents / 100, this.owner.scope.environment);
      requireFact(!preview.error, preview.error ?? 'Invalid order.');
      const request: OrderRequest = { ...preview.request, clientOrderId: `paca-${id}` };
      this.sessionGate(facts, request, false);
      if (authorization && authorization.key !== manualReviewKey(preview)
        || preview.confirmationReasons.length && !authorization?.confirmed) throw new ManualReviewRequired(preview);
      const command: ManualCommand = { ...this.command(id, { kind: 'submit', request }), key: recordKey(this.scope, id),
        scope: this.scope, contract: EXECUTION_CONTRACT, commitmentCents: captured.side === 'buy' ? Math.ceil(preview.estimatedValue * 100) : 0, order: null };
      await this.saveManual(command);
      return this.sendManual(command, () => this.sessionGate(facts, request, false));
    });
  }

  cancelManual(id: string, orderId: string): Promise<ManualCommand> {
    return this.enqueue(async () => {
      this.ready(); const prior = this.manual.get(id); if (prior) return prior;
      await this.facts();
      const order = await this.reads.getOrder(orderId); this.assert();
      requireFact(!this.claims(order.symbol), 'Use the run’s Close action for its owned orders.');
      requireFact(this.owner.scope.environment !== 'live' || this.armed, 'Arm live manual trading before cancellation.');
      requireFact(![...this.manual.values()].some(command => unresolved(command) && command.action.kind === 'cancel' && command.action.orderId === orderId), 'This cancellation is awaiting reconciliation.');
      const command: ManualCommand = { ...this.command(id, { kind: 'cancel', orderId, symbol: order.symbol }),
        key: recordKey(this.scope, id), scope: this.scope, contract: EXECUTION_CONTRACT, commitmentCents: 0, order };
      await this.saveManual(command); return this.sendManual(command, () => this.ready());
    });
  }
  private async sendManual(command: ManualCommand, check: () => void): Promise<ManualCommand> {
    const result = await this.send(command, check, true);
    let next = { ...command, ...result.command };
    if (result.order) next = this.observeManual(next, result.order);
    else if (['not_sent', 'rejected'].includes(next.status)) next.commitmentCents = 0;
    await this.saveManual(next); return next;
  }
  /** All POST/DELETE calls occur here, once, after a committed pending intent. */
  private async send(command: CommandEvidence, check: () => void, manual = false): Promise<{ command: CommandEvidence; order: Order | null }> {
    try { this.assert(); check(); }
    catch (error) { return { command: { ...command, status: 'not_sent', error: message(error) }, order: null }; }
    try {
      const action = command.action;
      const order = action.kind === 'submit' ? await this.writes.submitOrder(action.request) : (await this.writes.cancelOrder(action.orderId), null);
      if (action.kind === 'submit') {
        requireFact(order && order.symbol === action.request.symbol && order.side === action.request.side
          && order.clientOrderId === action.request.clientOrderId && order.qty === action.request.qty, 'The broker acknowledgement does not match the persisted request.');
        observeOrder([], order!);
        if (manual) observeManualOrder(action.request, null, order!);
        else if (action.request.stopLoss) observeRobotOrder({ commands: [command], orders: [] }, order!);
        if (action.request.type === 'stop') requireFact(order!.type === 'stop' && order!.stopPrice === action.request.stopPrice
          && order!.timeInForce === action.request.timeInForce, 'Broker protection acknowledgement does not match the persisted stop.');
      }
      return { command: { ...command, status: 'acknowledged', brokerOrderId: order?.id ?? (action.kind === 'cancel' ? action.orderId : null) }, order };
    } catch (error) {
      return { command: { ...command, status: error instanceof BrokerWriteError && !error.uncertain ? 'rejected' : 'uncertain', error: message(error) }, order: null };
    }
  }

  pause(id: string): Promise<void> {
    return this.enqueue(async () => { this.ready(); const run = this.run(id); await this.save({ ...run, state: 'paused', supervisionInterrupted: true }); });
  }
  resume(id: string): Promise<void> {
    return this.enqueue(async () => {
      requireFact(this.robotEntriesAllowed(), 'Enable live Robot entries for this connection before resuming.');
      this.ready(); const run = await this.reconcileRun(this.run(id));
      requireFact(!run.blocked && !this.ambiguous(), run.blocked ?? 'Reconcile uncertain account commands.');
      requireFact(this.now() < Date.parse(run.approved.plan.intendedEnd), 'The approved plan has ended. Use Close.');
      await this.save({ ...run, state: 'running' });
    });
  }
  close(id: string): Promise<void> {
    return this.enqueue(async () => {
      this.ready(); let run = this.run(id);
      await this.save({ ...run, state: 'closing', supervisionInterrupted: run.supervisionInterrupted || this.now() < Date.parse(run.approved.plan.intendedEnd) });
      run = await this.reconcileRun(this.run(id));
      if (!run.blocked) await this.closeStep(run);
    });
  }
  protect(id: string): Promise<void> {
    return this.enqueue(async () => {
      this.ready(); const run = await this.reconcileRun(this.run(id));
      requireFact(!run.blocked, run.blocked ?? 'Reconcile before attaching protection.');
      requireFact(!run.exitRequested && run.state !== 'closing', 'The run is already exiting.');
      await this.ensureProtection(run);
    });
  }
  reconcile(): Promise<void> {
    return this.enqueue(() => this.reconcileAccount());
  }
  /** Scheduled supervision and diagnostic refresh use the same account observations. */
  private async reconcileAccount(): Promise<void> {
    let facts: Promise<Facts> | undefined;
    const readFacts = () => facts ??= this.facts();
    const sharedOrders = this.orderReads(readFacts);
    const ordersByCommand = new Map<string, Promise<Order | null>>();
    const lookup = (command: CommandEvidence) => {
      const orderId = command.action.kind === 'cancel' ? command.action.orderId : command.brokerOrderId;
      const key = orderId ? `order:${orderId}` : `client:${command.action.kind === 'submit' ? command.action.request.clientOrderId : ''}`;
      let order = ordersByCommand.get(key);
      if (!order) { order = sharedOrders.lookup(command); ordersByCommand.set(key, order); }
      return order;
    };
    const errors: string[] = [];
    try {
      this.ready();
      for (const command of [...this.manual.values()]) {
        try { await this.reconcileManual(command, lookup); }
        catch (error) {
          this.ready(); // A storage failure or closed session must stop the cycle.
          errors.push(message(error));
          await this.saveManual({ ...command, error: message(error) });
        }
      }
      for (const run of [...this.runs.values()].filter(run => run.active)) await this.reconcileRun(run, readFacts, sharedOrders);
      const observed = await readFacts();
      // Direct journal observations include terminal orders omitted by broker lists.
      // Keep the displayed order state tied to the evidence used for commitments.
      const orders = new Map(observed.orders.map(order => [order.id, order]));
      const manualOrders = new Map<string, Order>();
      for (const command of this.manual.values()) if (command.order) {
        const prior = manualOrders.get(command.order.id);
        manualOrders.set(command.order.id, observeOrder(prior ? [prior] : [], command.order)[0]);
      }
      for (const order of manualOrders.values()) {
        orders.set(order.id, order);
        for (const child of order.legs ?? []) orders.set(child.id, observeOrder(orders.has(child.id) ? [orders.get(child.id)!] : [], child)[0]);
      }
      for (const run of this.runs.values()) for (const order of run.orders) orders.set(order.id, order);
      this.observation = { ...observed, orders: [...orders.values()] };
      this.reconciliationError = errors.join('; ') || null;
    } catch (error) {
      this.reconciliationError = message(error); throw error;
    } finally { this.publish(); }
  }
  private run(id: string): Run {
    const run = this.runs.get(id); requireFact(run?.active, 'This active run is unavailable.'); return run!;
  }
  private async reconcileManual(command: ManualCommand, lookup: (command: CommandEvidence) => Promise<Order | null>): Promise<void> {
    if (['not_sent', 'rejected', 'resolved'].includes(command.status)) {
      if (command.commitmentCents) await this.saveManual({ ...command, commitmentCents: 0 });
      return;
    }
    const order = await lookup(command); this.assert();
    if (!order) return; // Absence is not proof that the original request was rejected.
    await this.saveManual(this.observeManual(command, order));
  }
  private observeManual(command: ManualCommand, order: Order): ManualCommand {
    const action = command.action;
    requireFact(action.kind === 'submit'
      ? order.clientOrderId === action.request.clientOrderId && order.symbol === action.request.symbol && order.side === action.request.side && order.qty === action.request.qty
      : order.id === action.orderId && order.symbol === action.symbol, 'Conflicting broker command identity.');
    const observed = action.kind === 'submit' ? observeManualOrder(action.request, command.order, order)
      : observeOrder(command.order ? [command.order] : [], order)[0];
    const working = isWorkingOrder(observed.status) || !!observed.legs?.some(child => isWorkingOrder(child.status));
    const remaining = observed.qty! - observed.filledQty!;
    const previousRemaining = observed.qty! - (command.order?.filledQty ?? 0);
    const commitmentCents = !isWorkingOrder(observed.status) ? 0 : action.kind === 'submit' && action.request.side === 'buy'
      ? action.request.limitPrice !== undefined ? Math.ceil(remaining * action.request.limitPrice * 100)
        : previousRemaining > 0 ? Math.ceil(command.commitmentCents * remaining / previousRemaining) : command.commitmentCents
      : 0;
    return { ...command, order: observed, brokerOrderId: observed.id,
      status: working ? 'acknowledged' : 'resolved', commitmentCents, error: null };
  }
  /** One cycle's order batch and direct fallbacks; never reused across writes/cycles. */
  private orderReads(readFacts: () => Promise<Facts>) {
    const byId = new Map<string, Promise<Order>>();
    const get = (id: string): Promise<Order> => {
      const pending = byId.get(id); if (pending) return pending;
      const request = (async () => {
        const orders = (await readFacts()).orders, listed = orders.find(order => order.id === id);
        // An OTO child has no legs of its own. Its fresh parent linkage can come
        // from either the flattened order or the nested account response.
        const missingLegs = listed?.orderClass === 'oto' && !listed.legs?.length && !listed.parentOrderId
          && !orders.some(parent => parent.legs?.some(child => child.id === id));
        const order = listed && !missingLegs ? listed : await this.reads.getOrder(id);
        for (const child of order.legs ?? []) if (!byId.has(child.id)) byId.set(child.id, Promise.resolve(child));
        return order;
      })();
      byId.set(id, request); return request;
    };
    const lookup = async (command: CommandEvidence): Promise<Order | null> => {
      if (command.action.kind === 'cancel') return get(command.action.orderId);
      if (command.brokerOrderId) return get(command.brokerOrderId);
      const clientId = command.action.request.clientOrderId!;
      const listed = (await readFacts()).orders.find(order => order.clientOrderId === clientId);
      return listed ? get(listed.id) : this.reads.getOrderByClientOrderId(clientId);
    };
    return { get, lookup };
  }
  private async reconcileRun(saved: Run, readFacts: () => Promise<Facts> = () => this.facts(), sharedOrders?: ReturnType<Trading['orderReads']>): Promise<Run> {
    let facts: Promise<Facts> | undefined;
    const currentFacts = () => facts ??= readFacts(), orderReads = sharedOrders ?? this.orderReads(currentFacts);
    let run = { ...saved, commands: saved.commands.map(command => ({ ...command })) };
    try {
      for (const command of run.commands) {
        if (['rejected', 'not_sent', 'resolved'].includes(command.status)) continue;
        const order = await orderReads.lookup(command); this.assert();
        if (!order) continue;
        if (command.action.kind === 'submit') requireFact(order.clientOrderId === command.action.request.clientOrderId
          && order.symbol === command.action.request.symbol && order.side === command.action.request.side, 'Conflicting broker command identity.');
        run.orders = observeRobotOrder(run, order);
        command.brokerOrderId = order.id;
        command.status = isWorkingOrder(run.orders.find(value => value.id === order.id)!.status) ? 'acknowledged' : 'resolved';
        command.error = null;
      }
      // Working children still reconcile after their submission commands resolve.
      for (const order of run.orders.filter(order => isWorkingOrder(order.status))) {
        run.orders = observeRobotOrder(run, await orderReads.get(order.id)); this.assert();
      }
      const activities: TradeActivity[] = [];
      const missingFills = run.orders.filter(order => order.filledQty! > run.fills.filter(fill => fill.orderId === order.id).reduce((sum, fill) => sum + fill.qty, 0) + 1e-10);
      if (missingFills.length) {
        const after = missingFills.map(order => order.submittedAt).sort()[0];
        let pageToken: string | undefined;
        for (let page = 0; page < 20; page++) {
          const result = await this.reads.getTradeActivities({ after, pageToken }); this.assert();
          activities.push(...result.activities);
          if (!result.nextPageToken) break;
          requireFact(page < 19, 'Required fill evidence exceeds the bounded history request.');
          requireFact(result.nextPageToken !== pageToken, 'Trade history pagination did not advance.');
          pageToken = result.nextPageToken;
        }
      }
      run.fills = observeFills(run, activities);
      const owned = ownedInventory(run), facts = await currentFacts(), symbol = run.approved.plan.symbol;
      const position = facts.positions.find(position => position.symbol === symbol);
      requireFact((position?.qty ?? 0) === owned.quantity && (!position || position.side === 'long'), 'External activity or inconsistent account inventory: execution is paused.');
      requireFact(!facts.orders.some(order => order.symbol === symbol && isWorkingOrder(order.status) && !run.orders.some(own => own.id === order.id)), 'External working order conflicts with this run.');
      const pendingCommands = run.commands.filter(unresolved);
      if (pendingCommands.length && pendingCommands.every(command => command.action.kind === 'cancel' && command.status === 'acknowledged')) {
        run.blocked = 'Cancellation is unconfirmed; existing orders can still fill.';
        await this.save(run); return run;
      }
      requireFact(!pendingCommands.length, 'A command remains uncertain or cancellation is unconfirmed.');
      run.blocked = null; run.reconciledAt = iso(this.now());
      if (owned.quantity === 0 && run.orders.every(order => !isWorkingOrder(order.status))) run.exitRequested = false;
      if (run.strategy.signal?.disposition === 'pending_submission' || run.strategy.signal?.disposition === 'uncertain') {
        run.strategy = { ...run.strategy, signal: { ...run.strategy.signal, disposition: 'acknowledged' } };
      }
      if (run.state === 'closing' && owned.quantity === 0 && run.orders.every(order => !isWorkingOrder(order.status))) {
        run.state = 'ended'; run.active = 0; run.endedAt = iso(this.now());
      }
    } catch (error) {
      this.assert(); run.blocked = message(error); run.supervisionInterrupted = true;
      if (run.state === 'running') run.state = 'paused';
    }
    await this.save(run); return run;
  }

  /** At most one pending tick; bulk research never enters this queue. */
  tick(): Promise<void> {
    if (this.tickPending || this.disposed) return Promise.resolve();
    this.tickPending = true;
    return this.enqueue(async () => {
      const supervision = [...this.runs.values()].some(run => run.active)
        || [...this.manual.values()].some(command => !['not_sent', 'rejected', 'resolved'].includes(command.status))
        || this.observation?.orders.some(order => isWorkingOrder(order.status));
      const age = this.observation ? this.now() - this.observation.at : Infinity;
      // Idle display refresh needs fewer requests. Active runs, working orders,
      // errors and explicit reconcile/pre-write checks keep their normal cadence.
      if (!supervision && !this.reconciliationError && age >= 0 && age < 15_000) return;
      await this.reconcileAccount();
      for (const saved of [...this.runs.values()].filter(run => run.active)) {
        let run = saved;
        if (run.state === 'paused') continue; // Broker stops still reconcile while strategy supervision is paused.
        if (this.now() - (this.pulses.get(run.id) ?? Date.parse(run.approved.approvedAt)) > 30_000) run = { ...run, supervisionInterrupted: true };
        this.pulses.set(run.id, this.now());
        if (run.blocked || !run.active) continue;
        if (!this.market.ready()) continue;
        try {
          if (run.state === 'running' && this.now() >= Date.parse(run.approved.plan.intendedEnd)) {
            run = { ...run, state: 'closing' }; await this.save(run);
          }
          if (run.state === 'closing' || run.exitRequested) { await this.closeStep(run); continue; }
          // Canceled partial entries and canceled/rejected stops need a new backup.
          if (run.approved.plan.sessionMode !== '24x5' && ownedInventory(run).quantity! > 0 && !run.orders.some(order => isWorkingOrder(order.status))) {
            await this.ensureProtection(run); continue;
          }
          const market = await this.market.snapshot(run.approved.plan); this.assert();
          const held = ownedInventory(run), quote = this.market.quote(run.approved.plan.symbol);
          if (run.approved.plan.sessionMode === '24x5' && held.quantity! > 0 && held.averageEntryPriceUsd
            && freshQuote(quote, this.now(), 'limit', true)) {
            const stop = run.orders.find(order => isProtectionOrder(order) && isWorkingOrder(order.status))?.stopPrice
              ?? backupStopPrice(run.approved.plan, held.averageEntryPriceUsd, held.quantity!, held.averageEntryPriceUsd);
            if (quote!.price! <= stop || quote!.bid! <= stop) {
              run = { ...run, exitRequested: true }; await this.save(run); await this.closeStep(run); continue;
            }
          }
          const risk = entryRiskBlock(run, market.quote?.priceUsd ?? null);
          const leftoverStop = held.quantity === 0 && run.orders.some(order => isProtectionOrder(order) && isWorkingOrder(order.status)
            // An OTO child held for its still-working entry is not a prior stop.
            && !(order.status === 'held' && run.orders.some(parent => parent.id === order.parentOrderId && parent.side === 'buy' && isWorkingOrder(parent.status))));
          const result = evaluateTemplate({ approved: run.approved, runId: run.id, decisionId: `decision-${crypto.randomUUID()}`,
            evaluatedAt: iso(this.now()), market, owned: held,
            state: { ...run.strategy, firstFillAt: run.strategy.firstFillAt === null ? null : strategyInstant(run.strategy.firstFillAt) },
            execution: { workingOrders: run.orders.filter(order => isWorkingOrder(order.status) && !isProtectionOrder(order)).map(order => ({ id: order.id,
              side: order.side, cancellationPending: run.commands.some(command => command.action.kind === 'cancel' && command.action.orderId === order.id && unresolved(command)),
              limitPriceUsd: order.limitPrice ?? null, submittedAt: strategyInstant(order.submittedAt) })),
            pendingSubmission: false, uncertain: false, entriesAllowed: this.robotEntriesAllowed() && !this.ambiguous() && !risk && !leftoverStop,
            entryBlocks: [...(risk ? [{ category: 'portfolio' as const, code: 'run_loss_or_cost_hold', reason: risk }] : []),
              ...(leftoverStop ? [{ category: 'execution' as const, code: 'prior_stop_pending', reason: 'The previous attached stop must be terminal before another entry.' }] : []),
              ...(!this.robotEntriesAllowed() ? [{ category: 'execution' as const, code: 'live_robot_entries_disabled', reason: 'Live Robot entries are disabled; approved exits remain enabled.' }] : [])] } });
          run = { ...run, strategy: result.state, latestDecision: result.decision,
            supervisionInterrupted: run.supervisionInterrupted || result.decision.vetoes.some(veto => ['data', 'execution', 'capability'].includes(veto.category)) };
          const intent = result.intent;
          if (!intent) {
            await this.save(run);
            if (ownedInventory(run).quantity! > 0 && !run.orders.some(order => isWorkingOrder(order.status))) await this.ensureProtection(run);
            continue;
          }
          if (intent.kind === 'cancel') {
            for (const orderId of intent.orderIds) run = await this.runCommand(run, { kind: 'cancel', orderId, symbol: run.approved.plan.symbol });
          } else if (intent.side === 'sell') {
            run = { ...run, exitRequested: true }; await this.save(run);
            await this.closeStep(run);
          } else {
            await this.runCommand(run, { kind: 'submit', request: { symbol: run.approved.plan.symbol, side: intent.side,
              qty: intent.quantity, type: intent.orderType, ...(intent.limitPriceUsd === null ? {} : { limitPrice: intent.limitPriceUsd }) } });
          }
        } catch (error) {
          if (error instanceof MarketDataUnavailableError) continue;
          this.assert(); await this.save({ ...this.run(run.id), state: 'paused', supervisionInterrupted: true, blocked: message(error) });
        }
      }
    }).finally(() => { this.tickPending = false; });
  }
  private async closeStep(run: Run): Promise<void> {
    if (run.commands.some(unresolved)) return;
    const working = run.orders.filter(order => isWorkingOrder(order.status));
    if (working.length) {
      // Cancel the parent first; Alpaca cancels the whole OTO group. Never send
      // a second cancellation or sell until the first cancellation is confirmed.
      const order = working.find(order => order.side === 'buy') ?? working.find(isProtectionOrder);
      if (!order) return; // An acknowledged sell must reach a terminal broker state.
      await this.runCommand(run, { kind: 'cancel', orderId: order.id, symbol: order.symbol });
      return;
    }
    const owned = ownedInventory(run);
    if (owned.quantity! > 0) await this.runCommand(run, { kind: 'submit', request: { symbol: run.approved.plan.symbol, side: 'sell', qty: owned.quantity!, type: 'market' } });
  }
  private async ensureProtection(run: Run): Promise<void> {
    const owned = ownedInventory(run);
    requireFact(owned.quantity! > 0, 'There is no confirmed inventory to protect.');
    requireFact(!run.commands.some(unresolved), 'Reconcile the previous command first.');
    const working = run.orders.filter(order => isWorkingOrder(order.status));
    if (working.some(isProtectionOrder)) return;
    requireFact(!working.length, 'Resolve the working entry or exit before attaching a stop.');
    const quote = this.market.quote(run.approved.plan.symbol);
    if (run.approved.plan.sessionMode === '24x5') {
      if (!freshQuote(quote, this.now(), 'limit', true)) throw new MarketDataUnavailableError('Waiting for a fresh protection quote.');
      const threshold = backupStopPrice(run.approved.plan, owned.averageEntryPriceUsd!, owned.quantity!, owned.averageEntryPriceUsd!);
      if (quote!.price! <= threshold || quote!.bid! <= threshold) {
        run = { ...run, exitRequested: true }; await this.save(run); await this.closeStep(run); return;
      }
    }
    const stopPrice = backupStopPrice(run.approved.plan, owned.averageEntryPriceUsd!, owned.quantity!, quote?.price ?? 0);
    await this.runCommand(run, { kind: 'submit', request: { symbol: run.approved.plan.symbol, side: 'sell', qty: owned.quantity!,
      type: 'stop', stopPrice, timeInForce: 'gtc' } });
  }
  private robotRequest(run: Run, request: OrderRequest, facts: Facts): OrderRequest {
    const quote = this.market.quote(request.symbol);
    const extended = tradingSession(facts.clock, this.now()) !== 'regular';
    if (extended && request.type !== 'stop' && (run.approved.plan.sessionMode === '24x5' || request.side === 'sell')) {
      const limitPrice = request.limitPrice ?? automaticLimitPrice(request.side, quote?.bid, quote?.ask);
      if (limitPrice === null) throw new MarketDataUnavailableError('A current bid and ask are required for a 24/5 limit order.');
      return { ...request, type: 'limit', limitPrice, timeInForce: 'day', extendedHours: true };
    }
    return request;
  }
  private async runCommand(run: Run, action: CommandAction): Promise<Run> {
    requireFact(!run.commands.some(unresolved), 'Reconcile the previous command first.');
    const id = crypto.randomUUID(), facts = await this.facts();
    if (action.kind === 'submit') {
      let request = this.robotRequest(run, { ...action.request, clientOrderId: `paca-${id}` }, facts);
      if (request.side === 'buy' && !request.extendedHours) {
        const quote = this.market.quote(request.symbol);
        request = { ...request, timeInForce: 'gtc', stopLoss: {
          stopPrice: backupStopPrice(run.approved.plan, request.limitPrice ?? quote?.ask ?? 0, request.qty, quote?.price ?? 0),
        } };
      }
      action = { kind: 'submit', request };
    }
    const check = () => {
      this.ready();
      if (action.kind === 'cancel') {
        if (run.orders.some(order => order.id === action.orderId && isProtectionOrder(order)) && ownedInventory(run).quantity! > 0) {
          // Retain broker protection when an immediate strategy exit cannot be sent.
          this.sessionGate(facts, this.robotRequest(run, { symbol: action.symbol, side: 'sell', qty: ownedInventory(run).quantity!, type: 'market' }, facts), true);
          requireFact((facts.positions.find(position => position.symbol === action.symbol)?.qty ?? 0) === ownedInventory(run).quantity,
            'Observable inventory changed before canceling protection. Reconcile first.');
        }
        return;
      }
      const request = action.request;
      this.sessionGate(facts, request, true);
      const position = facts.positions.find(position => position.symbol === request.symbol);
      requireFact((position?.qty ?? 0) === ownedInventory(run).quantity, 'Observable external inventory changed before the write.');
      requireFact(!facts.orders.some(order => order.symbol === request.symbol && isWorkingOrder(order.status)
        && !run.orders.some(owned => owned.id === order.id)), 'An external order appeared before the write.');
      requireFact(request.side !== 'buy' || run.state === 'running' && !this.ambiguous(id), 'Entries are paused or account commands are uncertain.');
      if (request.side === 'sell') {
        requireFact(request.qty <= ownedInventory(run).quantity!, 'Sell quantity exceeds attributable confirmed fills.');
        requireFact(!run.orders.some(order => isWorkingOrder(order.status)), 'Confirm all working orders are terminal before another sell.');
      }
      else {
        requireFact(!run.orders.some(order => isWorkingOrder(order.status)), 'Confirm previous orders, including attached stops, are terminal before another entry.');
        const price = request.limitPrice ?? this.market.quote(request.symbol)?.ask;
        requireFact(price && request.qty * price * 100 <= Math.min(run.ceilingCents, this.remainingCapital(facts, run), facts.account.cash * 100), 'Capital is no longer available.');
      }
    };
    check();
    const command = this.command(id, action);
    run = { ...run, commands: [...run.commands, command] }; await this.save(run);
    const result = await this.send(command, check);
    const next = { ...run, commands: run.commands.map(value => value.id === id ? result.command : value),
      orders: result.order ? observeRobotOrder(run, result.order) : run.orders };
    if (next.strategy.signal) next.strategy = { ...next.strategy, signal: { ...next.strategy.signal,
      disposition: result.command.status === 'acknowledged' ? 'acknowledged' : result.command.status === 'uncertain' ? 'uncertain' : 'rejected' } };
    if (result.command.status !== 'acknowledged') {
      next.state = 'paused'; next.supervisionInterrupted = true;
      next.blocked = result.command.error ?? 'Explicit action is required before another decision.';
    }
    await this.save(next); return next;
  }
}
