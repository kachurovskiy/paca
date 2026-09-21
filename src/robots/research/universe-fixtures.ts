/** Synthetic inputs for unit/browser checks, never imported by the application. */
import { calendarTimeToUtc } from '../../broker/market-data';
import { type ResearchQuote, type ScannerAsset } from '../../core/market-data';
import type { ScannerBar, ScannerSession } from '../../scanner/types';
import type { UniverseContext } from './universe';

export function universeFixture(date = '2026-09-17', close = '16:00', count = 3) {
  const today = { date, open: calendarTimeToUtc(date, '09:30'), close: calendarTimeToUtc(date, close) };
  const previous: ScannerSession[] = [];
  for (let time = Date.parse(`${date}T12:00:00Z`) - 86_400_000; previous.length < 20; time -= 86_400_000) {
    if ([0, 6].includes(new Date(time).getUTCDay())) continue;
    const prior = new Date(time).toISOString().slice(0, 10);
    previous.unshift({ date: prior, open: calendarTimeToUtc(prior, '09:30'), close: calendarTimeToUtc(prior, '16:00') });
  }
  const now = today.open + 60_000;
  const context: UniverseContext = {
    scope: { broker: 'alpaca', accountId: 'synthetic-universe-account', environment: 'paper' }, connectionGeneration: 1, tradingDate: date,
    data: { status: 'available', feed: 'sip', asOf: new Date(now).toISOString(), validUntil: new Date(now + 60_000).toISOString(),
      provenanceRef: 'synthetic-sip-assessment', capabilities: ['observed_prices', 'completed_5min_bars', 'bid_ask'] },
  };
  const assets: ScannerAsset[] = Array.from({ length: count }, (_, index) => ({ symbol: `S${String(index).padStart(4, '0')}`, id: `synthetic-listing-${index}`, name: 'Synthetic equity', exchange: 'NASDAQ' }));
  const daily = (symbols: string[]): Record<string, ScannerBar[]> => Object.fromEntries(symbols.map(symbol => [symbol, previous.map(session => ({
    t: new Date(calendarTimeToUtc(session.date, '00:00')).toISOString(), o: 11, h: 12, l: 9, c: 10,
    v: (Number(symbol.slice(1)) + 1) * 1000, vw: 10,
  }))])); // Down-day candles deliberately remain neutral candidates.
  const quotes = (symbols: string[]): Record<string, ResearchQuote> => Object.fromEntries(symbols.map(symbol => [symbol, {
    price: 10, tradeAt: new Date(now).toISOString(), bid: 9.99, ask: 10.01, quoteAt: new Date(now).toISOString(),
  }]));
  return { today, previous, now, context, assets, daily, quotes };
}
