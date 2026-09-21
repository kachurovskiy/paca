import type { AccountScope } from '../core/account';

export function executionProvenance(scope: AccountScope): 'paper_execution' | 'live_execution' {
  return scope.environment === 'live' ? 'live_execution' : 'paper_execution';
}

/** Immutable accounting evidence supplied by the portfolio projection. No run authority. */
export interface ExecutionOutcomeFacts {
  readonly scope: AccountScope;
  readonly proposalId: string;
  readonly runId: string;
  readonly approvalId: string;
  readonly activationAt: string;
  readonly endedAt: string | null;
  readonly grossPnlUsd: string | null;
  readonly netPnlUsd: string | null;
  readonly feesKnown: boolean;
  readonly tradeStatus: 'traded' | 'no_trade' | 'unknown';
  readonly exclusions: readonly string[];
}
