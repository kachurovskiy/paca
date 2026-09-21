import type { ApprovedPlan, DecisionTrace } from '../robots/domain';
import type { TemplateState } from '../robots/templates/types';
import type { Order, OrderRequest, TradeActivity } from '../core/types';

export const EXECUTION_CONTRACT = 'paca-snapshots-2';
export type CommandStatus = 'pending' | 'acknowledged' | 'rejected' | 'uncertain' | 'not_sent' | 'resolved';
export type CommandAction = { kind: 'submit'; request: OrderRequest } | { kind: 'cancel'; orderId: string; symbol: string };
export interface CommandEvidence {
  id: string;
  createdAt: string;
  action: CommandAction;
  status: CommandStatus;
  brokerOrderId: string | null;
  error: string | null;
}
export interface ManualCommand extends CommandEvidence {
  key: string;
  scope: string;
  contract: typeof EXECUTION_CONTRACT;
  commitmentCents: number;
  order: Order | null;
}
export interface Run {
  key: string;
  scope: string;
  contract: typeof EXECUTION_CONTRACT;
  id: string;
  approvalCommandId: string;
  active: 0 | 1;
  state: 'running' | 'paused' | 'closing' | 'ended';
  blocked: string | null;
  supervisionInterrupted: boolean;
  /** Durable strategy exit, including the cancel-stop/confirm/sell transition. */
  exitRequested: boolean;
  approved: ApprovedPlan;
  ceilingCents: number;
  strategy: TemplateState;
  orders: Order[];
  fills: TradeActivity[];
  commands: CommandEvidence[];
  latestDecision: DecisionTrace | null;
  reconciledAt: string | null;
  endedAt: string | null;
}
export const unresolved = (command: CommandEvidence): boolean =>
  ['pending', 'uncertain'].includes(command.status) || command.action.kind === 'cancel' && command.status === 'acknowledged';
export const recordKey = (scope: string, id: string): string => JSON.stringify([scope, id]);

export interface ExecutionStorage {
  getActiveRuns(scope: string): Promise<Run[]>;
  getRun(scope: string, id: string): Promise<Run | null>;
  getRunHistory(scope: string): Promise<Run[]>;
  saveRun(run: Run): Promise<void>;
  getManualCommands(scope: string): Promise<ManualCommand[]>;
  saveManualIntent(command: ManualCommand): Promise<void>;
}
