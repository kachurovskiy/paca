/** Deterministic synthetic research inputs shared by unit and browser integration tests. */
import { ScannerCache } from '../../market/cache';
import type { ScannerBarsRequest } from '../../core/market-data';
import type { ScannerBar } from '../../scanner/types';
import { UniverseService } from './universe';
import { universeFixture } from './universe-fixtures';

export function trendFixture(count = 3) {
  const fixture = universeFixture('2026-09-21', '16:00', count);
  const history = (symbol: string, options: ScannerBarsRequest): ScannerBar[] => [14, 15, 16, 17, 18].flatMap(day =>
    Array.from({ length: 78 }, (_, index) => {
      // S0000 cannot produce an entry; every other symbol has a rising training/holdout series.
      const step = symbol === 'S0000' ? -0.1 : 0.1;
      const o = 100 + index * step, c = o + step;
      return { t: new Date(Date.UTC(2026, 8, day, 13, 30) + index * 300_000).toISOString(),
        o, c, h: Math.max(o, c) + 0.01, l: Math.min(o, c) - 0.01, v: 1000, vw: null };
    })).filter(bar => Date.parse(bar.t) >= options.start && Date.parse(bar.t) < options.end);
  const api = {
    getCalendar: async () => [...fixture.previous, fixture.today], getEligibleAssets: async () => fixture.assets,
    getResearchQuotes: async (symbols: string[]) => fixture.quotes(symbols),
    getBars: async (symbols: string[], options: ScannerBarsRequest, _signal?: AbortSignal) => options.timeframe === '1Day'
      ? fixture.daily(symbols) : Object.fromEntries(symbols.map(symbol => [symbol, history(symbol, options)])),
  };
  const capture = async () => {
    const universe = new UniverseService(api, new ScannerCache(), () => fixture.now);
    universe.setContext(fixture.context);
    try {
      const output = await universe.capture('synthetic-trend-input');
      if (output.status !== 'available') throw new Error('Synthetic universe unavailable');
      return output.snapshot;
    } finally { universe.dispose(); }
  };
  return { ...fixture, history, api, capture };
}
