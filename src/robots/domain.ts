import type { AccountScope } from '../core/account';
/** Current research and strategy value types. */
export const ROBOT_SCHEMA_VERSION = 1;

export interface ScopedRecord {
  readonly schemaVersion: typeof ROBOT_SCHEMA_VERSION;
  readonly scope: AccountScope;
  readonly id: string;
}

export interface VersionedIdentity { readonly id: string; readonly version: number; }
export type TemplateIdentity = VersionedIdentity;

/** Supplied by a known template; there is no permissive default or registry here. */
export interface TemplateParameterContract {
  readonly identity: TemplateIdentity;
  readonly parameters: Readonly<Record<string, {
    readonly min: number;
    readonly max: number;
    readonly integer: boolean;
  }>>;
  readonly strictlyOrdered: readonly (readonly [string, string])[];
}

/** UTC instants use canonical ISO millisecond strings, separately from the venue date. */
export interface RobotSession {
  readonly calendarId: string;
  readonly tradingDate: string;
  readonly timeZone: 'America/New_York';
  readonly openAt: string;
  readonly closeAt: string;
  readonly calendarAsOf: string;
  readonly provenanceRef: string;
}

export interface EvidenceReference {
  readonly id: string;
  readonly policy: VersionedIdentity;
  readonly status: 'unavailable' | 'experimental' | 'validated';
  readonly provenance: 'simulation' | 'shadow' | 'paper_execution' | 'live_execution';
  readonly asOf: string;
  readonly dataCutoff: string;
  readonly limitations: readonly string[];
}

export interface UnavailableForecast {
  readonly status: 'unavailable';
  readonly reason: string;
  readonly meanPnlCents: null;
  readonly medianPnlCents: null;
  readonly quantiles: null;
  readonly probabilityOfProfit: null;
}

export interface NumericForecast {
  readonly status: 'experimental' | 'validated';
  readonly meanPnlCents: number | null;
  readonly medianPnlCents: number | null;
  readonly quantiles: readonly { readonly probability: number; readonly pnlCents: number }[] | null;
  readonly probabilityOfProfit: number | null;
  readonly asOf: string;
  readonly validUntil: string;
  readonly activationAt: string;
  readonly horizonEnd: string;
  readonly capitalCents: number;
  readonly equityCents: number;
  readonly model: VersionedIdentity;
  readonly evidenceRef: string;
  readonly sampleCount: number;
  readonly trainingWindow: { readonly from: string; readonly to: string };
  readonly calibrationWindow: { readonly from: string; readonly to: string };
  readonly diagnosticsRef: string;
  readonly assumptions: {
    readonly fees: string;
    readonly spread: string;
    readonly slippage: string;
    readonly fills: string;
    readonly liquidation: string;
  };
}

export type Forecast = UnavailableForecast | NumericForecast;

/** Compact immutable estimator evidence; optional only for older records. */
export interface ForecastEvidence {
  readonly schemaVersion: 1; readonly model: VersionedIdentity;
  readonly provenance: EvidenceReference['provenance']; readonly asOf: string;
  readonly evidenceRef: string; readonly cohortRef: string | null; readonly diagnosticsRef: string;
  readonly trainingWindow: { readonly from: string; readonly to: string };
  readonly calibrationWindow: { readonly from: string; readonly to: string };
  readonly trainingDates: number; readonly calibrationDates: number;
  readonly completeFraction: number | null; readonly noTradeWeight: number | null;
  readonly calibration: { readonly coverage: number; readonly lowerTail: number; readonly upperTail: number } | null;
  readonly features: { readonly asOf: string; readonly priceUsd: number | null; readonly dailyLiquidityUsd: number | null };
  readonly costs: NumericForecast['assumptions']; readonly reasons: readonly string[]; readonly limitations: readonly string[];
}

/** The exact reviewed proposal is copied into an approved run. */
export interface RobotProposal extends ScopedRecord {
  readonly revision: number;
  readonly opportunityKey: string;
  readonly template: TemplateIdentity;
  readonly symbol: string;
  readonly direction: 'long';
  readonly sessionMode: 'regular' | '24x5';
  readonly supervision: 'browser';
  readonly parameters: Readonly<Record<string, number>>;
  readonly session: RobotSession;
  readonly generatedAt: string;
  readonly dataCutoff: string;
  readonly validUntil: string;
  readonly dataProvenanceRef: string;
  readonly capital: {
    readonly ceilingCents: number;
    readonly equityCents: number;
    readonly snapshotAt: string;
  };
  readonly risk: {
    readonly budgetCents: number;
    readonly lossTriggerCents: number;
    readonly policy: VersionedIdentity;
  };
  readonly executionPolicy: VersionedIdentity;
  readonly exitPolicy: VersionedIdentity;
  readonly entryWindow: { readonly from: string; readonly to: string };
  readonly intendedEnd: string;
  /** Only named, bounded operational adaptations are permitted; parameters stay fixed. */
  readonly adaptationBounds: Readonly<Record<string, { readonly min: number; readonly max: number }>>;
  readonly rationale: readonly string[];
  readonly risks: readonly string[];
  readonly blocks: readonly Veto[];
  readonly evidence: EvidenceReference;
  readonly forecast: Forecast;
  readonly forecastEvidence?: ForecastEvidence;
  readonly allocatorPolicy: VersionedIdentity;
  readonly portfolioSnapshotRef: string;
}

/** A snapshot value only; creating it does not authorize a broker mutation. */
export interface ApprovedPlan extends ScopedRecord {
  readonly commandId: string;
  readonly approvedAt: string;
  readonly plan: RobotProposal;
}

export interface Veto {
  readonly category: 'portfolio' | 'data' | 'execution' | 'capability' | 'session' | 'approval';
  readonly code: string;
  readonly reason: string;
}

export type DecisionCondition = {
  readonly code: string;
  readonly inputRef: string;
  readonly operator: 'lt' | 'lte' | 'eq' | 'gte' | 'gt';
  readonly threshold: number | boolean | string;
} & ({ readonly result: 'pass' | 'fail'; readonly observed: number | boolean | string }
  | { readonly result: 'unavailable'; readonly observed: null; readonly reason: string });

export interface DecisionTrace extends ScopedRecord {
  readonly runId: string;
  readonly evaluatedAt: string;
  readonly dataCutoff: string;
  readonly template: TemplateIdentity;
  readonly policy: VersionedIdentity;
  readonly inputRefs: readonly string[];
  readonly conditions: readonly DecisionCondition[];
  readonly candidate: { readonly side: 'buy' | 'sell'; readonly quantity: number } | null;
  readonly vetoes: readonly Veto[];
  readonly action: 'hold' | 'request_entry' | 'request_exit' | 'request_cancel';
  readonly reasonCode: string;
}
