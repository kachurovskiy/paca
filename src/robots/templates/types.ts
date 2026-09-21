import type { Bar } from '../../core/types';
import type { MomentumReport } from '../math/momentum';
import type {
  ApprovedPlan, DecisionTrace, RobotSession, TemplateIdentity, TemplateParameterContract, Veto,
} from '../domain';

export type Capability = 'completed_5min_bars' | 'observed_prices' | 'bid_ask' | 'market_orders'
  | 'limit_orders' | 'cancel_confirmation' | 'owned_fills' | 'first_fill_activities';
export type ResearchCapability = Extract<Capability, 'completed_5min_bars' | 'observed_prices' | 'bid_ask'>;

/** Pre-plan eligibility only; data capabilities do not claim execution permissions or sufficient history. */
export interface DiscoveryEligibilityInput {
  readonly session: RobotSession;
  readonly dataCutoff: string;
  readonly capabilities: readonly ResearchCapability[];
  readonly quote: {
    readonly price: number | null; readonly tradeAt: string | null;
    readonly bid: number | null; readonly ask: number | null; readonly quoteAt: string | null;
  } | null;
}

/** Facts supplied by reconciliation, never inferred from account-wide holdings. */
export interface OwnedSnapshot {
  readonly quantity: number | null;
  /** Stable identity for this round trip, changed by reconciliation on a new entry. */
  readonly positionKey: string | null;
  readonly averageEntryPriceUsd: number | null;
  readonly entryAt: string | null;
  readonly firstFillAt: string | null;
}

export interface WorkingOrder {
  readonly id: string;
  readonly side: 'buy' | 'sell';
  readonly cancellationPending: boolean;
  readonly limitPriceUsd: number | null;
  readonly submittedAt: string;
}

export interface TemplateState {
  readonly schemaVersion: 1;
  readonly template: TemplateIdentity;
  readonly positionKey: string | null;
  readonly observedPeak: { readonly priceUsd: number; readonly at: string } | null;
  readonly firstFillAt: string | null;
  readonly signal: { readonly inputRef: string; readonly action: 'buy' | 'sell' | 'hold'; readonly disposition: 'no_action' | 'pending_submission' | 'acknowledged' | 'rejected' | 'uncertain' } | null;
}

export interface TemplateInput {
  readonly approved: ApprovedPlan;
  readonly runId: string;
  readonly decisionId: string;
  readonly evaluatedAt: string;
  readonly market: {
    readonly inputRef: string;
    readonly symbol: string;
    readonly dataCutoff: string;
    readonly session: RobotSession | null;
    readonly assetClass: 'us_equity' | 'crypto';
    readonly capabilities: readonly Capability[];
    readonly quote: { readonly at: string; readonly priceUsd: number; readonly bidUsd: number | null; readonly askUsd: number | null } | null;
    readonly bars: readonly Readonly<Bar>[];
  };
  readonly owned: OwnedSnapshot;
  readonly execution: {
    /** Null/uncertain facts block dependent evaluation. No broker access here. */
    readonly workingOrders: readonly WorkingOrder[] | null;
    readonly pendingSubmission: boolean;
    readonly uncertain: boolean;
    readonly entriesAllowed: boolean;
    readonly entryBlocks: readonly Veto[];
  };
  readonly state: TemplateState;
}

/** Candidates only: the future coordinator must persist/admit them before any I/O. */
export type CandidateIntent =
  | { readonly kind: 'entry'; readonly side: 'buy'; readonly quantity: number; readonly orderType: 'market' | 'limit'; readonly limitPriceUsd: number | null }
  | { readonly kind: 'exit'; readonly side: 'sell'; readonly quantity: number; readonly orderType: 'market'; readonly limitPriceUsd: null }
  | { readonly kind: 'cancel'; readonly orderIds: readonly string[] };

export interface TemplateResult {
  readonly intent: CandidateIntent | null;
  readonly state: TemplateState;
  readonly decision: DecisionTrace;
}

export interface ResearchInput {
  readonly symbol: string;
  readonly bars: readonly Readonly<Bar>[];
  readonly dataCutoff: string;
  /** Calendar coverage for every supplied bar date is required. */
  readonly sessions: readonly RobotSession[];
}
export type ResearchResult =
  | { readonly status: 'experimental'; readonly report: MomentumReport; readonly limitations: readonly string[] }
  | { readonly status: 'unavailable'; readonly reasonCode: string; readonly reason: string };

export interface StrategyTemplate extends TemplateParameterContract {
  readonly displayName: string;
  readonly description: string;
  readonly support: { readonly assets: readonly ['us_equity']; readonly direction: 'long'; readonly session: '24x5'; readonly environments: readonly ['paper', 'live']; readonly supervision: 'browser' };
  readonly requiredCapabilities: readonly Capability[];
  readonly executionPolicy: TemplateIdentity;
  readonly exitPolicy: TemplateIdentity;
  readonly diagnostics: { readonly version: 1; readonly conditionCodes: readonly string[];
    readonly presentation?: { readonly title: string; readonly description: string; readonly labels: Readonly<Record<string, string>>;
      readonly levels: readonly { readonly code: string; readonly field: 'observed' | 'threshold'; readonly label: string }[] } };
  readonly researchSupport: 'experimental_legacy_momentum' | 'unavailable';
  readonly simulationLimitations: readonly string[];
  validateParameters(value: unknown): void;
  discoveryEligibility(input: DiscoveryEligibilityInput): readonly Veto[];
  eligibility(input: TemplateInput): readonly Veto[];
  evaluate(input: TemplateInput): TemplateResult;
  research(input: ResearchInput): ResearchResult;
}
