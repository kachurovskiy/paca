import type { NumericForecast, RobotProposal, TemplateParameterContract } from './domain';
import { unavailableForecast } from './research/values';
import { opportunityKey } from './validation';

/** Synthetic unit-test data only; this contract does not register an executable template. */
export const templateFixture: TemplateParameterContract = {
  identity: { id: 'fixture-trend', version: 1 },
  parameters: {
    fastPeriod: { min: 2, max: 59, integer: true },
    slowPeriod: { min: 3, max: 60, integer: true },
    stopLossPct: { min: 0.1, max: 5, integer: false },
  },
  strictlyOrdered: [['fastPeriod', 'slowPeriod']],
};

type Mutable<T> = { -readonly [K in keyof T]: T[K] extends object ? Mutable<T[K]> : T[K] };

export function proposalFixture(): Mutable<RobotProposal> {
  const proposal: Mutable<RobotProposal> = {
    schemaVersion: 1, scope: { broker: 'fixture-broker', accountId: 'synthetic-account', environment: 'paper' },
    id: 'proposal-1', revision: 1, opportunityKey: '', template: { ...templateFixture.identity },
    symbol: 'TEST', direction: 'long', sessionMode: 'regular', supervision: 'browser',
    parameters: { fastPeriod: 5, slowPeriod: 20, stopLossPct: 1 },
    session: { calendarId: 'XNYS', tradingDate: '2026-09-18', timeZone: 'America/New_York',
      openAt: '2026-09-18T13:30:00.000Z', closeAt: '2026-09-18T20:00:00.000Z',
      calendarAsOf: '2026-09-18T12:00:00.000Z', provenanceRef: 'calendar-fixture' },
    generatedAt: '2026-09-18T13:55:00.000Z', dataCutoff: '2026-09-18T13:50:00.000Z',
    validUntil: '2026-09-18T14:10:00.000Z', dataProvenanceRef: 'bars-fixture',
    capital: { ceilingCents: 100_000, equityCents: 1_000_000, snapshotAt: '2026-09-18T13:54:00.000Z' },
    risk: { budgetCents: 5000, lossTriggerCents: 5000, policy: { id: 'fixture-risk', version: 1 } },
    executionPolicy: { id: 'fixture-observed-price', version: 1 }, exitPolicy: { id: 'fixture-exit', version: 1 },
    entryWindow: { from: '2026-09-18T14:00:00.000Z', to: '2026-09-18T19:45:00.000Z' }, intendedEnd: '2026-09-18T19:55:00.000Z',
    adaptationBounds: {}, rationale: ['Synthetic test candidate'], risks: ['Browser supervision is required'], blocks: [],
    evidence: { id: 'evidence-fixture', policy: { id: 'fixture-experimental', version: 1 }, status: 'experimental', provenance: 'simulation',
      asOf: '2026-09-18T13:54:00.000Z', dataCutoff: '2026-09-18T13:50:00.000Z', limitations: ['Synthetic test data'] },
    forecast: unavailableForecast('No estimator implemented'), allocatorPolicy: { id: 'fixture-allocator', version: 1 },
    portfolioSnapshotRef: 'portfolio-fixture',
  };
  proposal.opportunityKey = opportunityKey(proposal);
  return proposal;
}

export function numericForecastFixture(): NumericForecast {
  return { status: 'experimental', meanPnlCents: -100, medianPnlCents: null,
    quantiles: [{ probability: 0.05, pnlCents: -500 }, { probability: 0.95, pnlCents: 400 }], probabilityOfProfit: null,
    asOf: '2026-09-18T13:54:00.000Z', validUntil: '2026-09-18T14:10:00.000Z', activationAt: '2026-09-18T14:00:00.000Z',
    horizonEnd: '2026-09-18T20:00:00.000Z', capitalCents: 100_000, equityCents: 1_000_000, model: { id: 'fixture-model', version: 1 },
    evidenceRef: 'forecast-evidence-fixture', sampleCount: 10, diagnosticsRef: 'diagnostics-fixture',
    trainingWindow: { from: '2026-09-01T13:30:00.000Z', to: '2026-09-08T20:00:00.000Z' },
    calibrationWindow: { from: '2026-09-09T13:30:00.000Z', to: '2026-09-17T20:00:00.000Z' },
    assumptions: { fees: 'Synthetic only', spread: 'Synthetic only', slippage: 'Synthetic only', fills: 'Synthetic only', liquidation: 'Synthetic only' } };
}

