/** Synthetic test history only; never application or empirical forecasting evidence. */
import type { ScannerBarsRequest } from '../../core/market-data';
import { ScannerCache } from '../../market/cache';
import type { ScannerBar } from '../../scanner/types';
import { evaluateChronological, type ResearchRequest } from './chronological';
import { MEAN_REVERSION_POLICY, simulateMeanReversion } from './mean-reversion';
import { UniverseService } from './universe';
import { universeFixture } from './universe-fixtures';

export function meanReversionFixture(count = 1, date = '2026-09-18') {
  const f = universeFixture(date, '16:00', count);
  const history = (options: ScannerBarsRequest): ScannerBar[] => f.previous.flatMap(session => Array.from({ length: 78 }, (_, i) => {
    const price = i >= 9 && i <= 12 ? 99 : 100;
    return { t: new Date(session.open + i * 300_000).toISOString(), o: price, h: price + 0.02, l: price - 0.02, c: price, v: 100_000, vw: price };
  })).filter(b => Date.parse(b.t) >= options.start && Date.parse(b.t) < options.end);
  const api = { getCalendar: async () => [...f.previous, f.today], getEligibleAssets: async () => f.assets,
    getResearchQuotes: async (symbols: string[]) => Object.fromEntries(symbols.map(s => [s, { price: 100, tradeAt: new Date(f.now).toISOString(),
      bid: 99.99, ask: 100.01, quoteAt: new Date(f.now).toISOString() }])),
    getBars: async (symbols: string[], options: ScannerBarsRequest, _signal?: AbortSignal) => options.timeframe === '1Day' ? f.daily(symbols)
      : Object.fromEntries(symbols.map(s => [s, history(options)])) };
  const capture = async () => {
    const universe = new UniverseService(api, new ScannerCache(), () => f.now); universe.setContext(f.context);
    try { const output = await universe.capture('synthetic-mean-input'); if (output.status !== 'available') throw new Error('Missing synthetic universe'); return output.snapshot; }
    finally { universe.dispose(); }
  };
  const request = async (): Promise<ResearchRequest> => {
    const snapshot = await capture(), bars = history({ start: 0, end: f.now, timeframe: '5Min' });
    return { data: { id: 'synthetic-mean-data', sourceRef: 'synthetic-mean-source', asOf: snapshot.asOf, dataCutoff: snapshot.dataCutoff,
      calendarEvidence: 'retrospective', selection: { kind: 'supplied_symbols' },
      series: snapshot.candidates.slice(0, 2).flatMap(c => snapshot.previousSessions.map(session => ({ symbol: c.asset.symbol, session,
        bars: bars.filter(b => b.t >= session.openAt && b.t < session.closeAt).map(bar => ({ bar, availableAt: new Date(Date.parse(bar.t) + 300_000).toISOString() })) }))) },
      configurations: MEAN_REVERSION_POLICY.configurations, priorExposure: [], exposureHistoryComplete: true };
  };
  return { ...f, api, capture, history, request };
}
export function meanReversionReport(request: ResearchRequest) {
  const job = evaluateChronological(request, simulateMeanReversion); let step = job.next(); while (!step.done) step = job.next(); return step.value;
}
