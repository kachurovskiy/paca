/** Synthetic success/failure data only, never imported by the application. */
import type { ForecastObservation, ForecastTarget } from './forecasts';
import { prospectiveDraft, prospectiveCapture, scope } from './prospective-fixtures';
import type { RobotProposal } from '../domain';
import { opportunityKey } from '../validation';

export function forecastFixture(): { target: ForecastTarget; observations: ForecastObservation[] } {
  const plan = prospectiveDraft(), capture = prospectiveCapture(plan);
  const target: ForecastTarget = { scope, plan, provenance: 'simulation', costs: capture.assumptions, features: capture.features };
  const observations = Array.from({ length: 50 }, (_, index) => {
    const daysBefore = index < 30 ? 100 - index : 50 - (index - 30);
    const date = new Date(Date.parse(`${plan.session.tradingDate}T00:00:00.000Z`) - daysBefore * 86_400_000).toISOString().slice(0, 10);
    const past = JSON.parse(JSON.stringify(plan), (_key, value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T.*Z$/.test(value)
      ? date + value.slice(10) : value);
    past.session.tradingDate = date;
    const original: RobotProposal = { ...past, schemaVersion: 1, scope, id: `synthetic-forecast-plan-${index}`, revision: 1,
      opportunityKey: opportunityKey({ ...past, scope }) };
    const c = prospectiveCapture(original), offered = original.generatedAt, id = `synthetic-forecast-candidate-${index}`;
    const pnl = ['-1', '0', '0', '1', '5'][index % 5];
    return { plan: original, candidate: { ...c, schemaVersion: 1 as const, scope, id, batchId: `synthetic-forecast-batch-${index}`,
      recordedAt: offered, offeredAt: offered, capitalCents: original.capital.ceilingCents,
      proposal: { id: original.id, revision: 1 },
      features: { ...c.features, minutesToClose: (Date.parse(original.session.closeAt) - Date.parse(offered)) / 60_000 } },
    outcome: { schemaVersion: 1 as const, scope, id: `synthetic-forecast-outcome-${index}`, revision: 1, candidateId: id,
      recordedAt: new Date(Date.parse(original.session.closeAt) + 60_000).toISOString(), provenance: 'simulation' as const,
      activationAt: offered, horizonEnd: original.session.closeAt, approvalId: null, runId: null, disposition: 'expired' as const,
      completeness: 'complete' as const, fitExclusions: [], tradeStatus: pnl === '0' ? 'no_trade' as const : 'traded' as const,
      netPnlUsd: pnl, grossPnlUsd: pnl, feesKnown: true, costs: target.costs,
      inputRef: `synthetic-forecast-input-${index}`, evidenceRefs: ['synthetic-only-qualified-simulator'] } };
  });
  return { target, observations };
}
