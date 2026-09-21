import { describe, expect, it } from 'vitest';
import type { Mutable } from '../portfolio/test-fixtures';
import type { ResearchRequest } from './chronological';
import { researchReader } from './chronological';
import { MEAN_REVERSION_POLICY, meanReversionBatch, simulateMeanReversion } from './mean-reversion';
import { meanReversionFixture, meanReversionReport } from './mean-reversion-fixtures';
import { researchTrend } from './trend';

describe('independent mean reversion evidence', () => {
  it('passes the common folds, fixed neighbors, cost stress and baselines on explicit synthetic oscillation only', async () => {
    const f = meanReversionFixture(), report = meanReversionReport(await f.request());
    expect(report.gates, JSON.stringify(report.folds.map(f => f.reasons))).toBe('passed');
    expect(report.breadth.independentValidationSessions).toBe(10); expect(report.calendarClaim).toBe('retrospective_calendar');
    expect(report.forecast.status).toBe('unavailable');
    const batch = meanReversionBatch(await f.capture(), new Date(f.now).toISOString(), report, 'synthetic-report', 1);
    expect(batch.counts.selectedSymbols).toBe(1); expect(batch.evaluations[0].candidate?.forecast.status).toBe('unavailable');
    const snapshot = await f.capture(), search = researchTrend({ scope: snapshot.scope, symbol: snapshot.candidates[0].asset.symbol,
      snapshotRef: snapshot.id, session: snapshot.session, sessions: snapshot.previousSessions, dataCutoff: snapshot.dataCutoff,
      bars: f.history({ start: f.now - 7 * 86_400_000, end: f.now, timeframe: '5Min' }) });
    let step = search.next(); while (!step.done) step = search.next(); expect(step.value.candidate).toBeNull();
  }, 20_000);
  it('fills only after a signal observation and returns unavailable for missing volume or unobserved liquidation', async () => {
    const request = structuredClone(await meanReversionFixture().request()) as Mutable<ResearchRequest>, series = request.data.series[0];
    const cost = { id: 'observed-next', feesBpsPerSide: 1, spreadBpsPerSide: 2, slippageBpsPerSide: 2, observationDelay: 1 } as const;
    const result = simulateMeanReversion(MEAN_REVERSION_POLICY.configurations[0], researchReader(series, series.session.closeAt).reader, cost);
    expect(result).toMatchObject({ trades: 1, turnover: 2, fillModel: 'observed-next' });
    series.bars[10].bar.c = 98.9; series.bars[10].bar.l = 98.8; series.bars[10].bar.o = 98.9;
    expect(simulateMeanReversion(MEAN_REVERSION_POLICY.configurations[0], researchReader(series, series.session.closeAt).reader, cost)).not.toEqual(result);
    series.bars[0].bar.v = 0;
    expect(simulateMeanReversion(MEAN_REVERSION_POLICY.configurations[0], researchReader(series, series.session.closeAt).reader, cost)).toEqual({ unavailable: 'invalid_price_or_volume' });
  });
  
  
  
  
});
