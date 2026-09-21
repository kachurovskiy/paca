import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DataReads, MarketReads, MarketStream } from '../broker/reads';
import type { StreamHandlers, StreamStatus } from '../core/stream';
import { inputFixture, NOW } from '../robots/templates/test-fixtures';
import { wickCapture } from '../robots/templates/wick-capture';
import { Market } from './service';
import { MarketDataUnavailableError } from '../core/market-data';

const markets: Market[] = [];
afterEach(() => { markets.splice(0).forEach(market => market.dispose()); });
function setup() {
  let time = NOW + 6000;
  const plan = inputFixture().approved.plan, symbols = [plan.symbol, ...Array.from({ length: 19 }, (_, i) => `S${i}`)];
  let handlers: Partial<StreamHandlers> = {};
  const stream: MarketStream = { addListener: value => { handlers = value; return () => {}; }, setOwnerSubscriptions: vi.fn(), removeOwner: vi.fn() };
  const data = {
    getEligibleAssets: vi.fn(async () => symbols.map(symbol => ({ symbol, id: symbol, name: symbol, exchange: 'NASDAQ', overnightTradable: true }))),
    getCalendar: vi.fn(async () => [{ date: plan.session.tradingDate, open: Date.parse(plan.session.openAt), close: Date.parse(plan.session.closeAt) }]),
    getBars: vi.fn(async () => ({})),
    getResearchQuotes: vi.fn<DataReads['getResearchQuotes']>(async symbols => Object.fromEntries(symbols.map(symbol => [symbol, { price: 106, bid: 105.99, ask: 106.01, tradeAt: new Date(time).toISOString(), quoteAt: new Date(time).toISOString() }]))),
  };
  const reads = { getSnapshots: vi.fn(async () => ({})), getBars: vi.fn(async () => []), getPortfolioHistory: vi.fn() };
  const market = new Market(reads as MarketReads, data as unknown as DataReads, stream, vi.fn(), () => time); markets.push(market);
  handlers.onStatus?.('ready', 'Ready');
  const emit = (symbol = plan.symbol) => {
    const timestamp = new Date(time).toISOString();
    handlers.onTrade?.({ symbol, timestamp, price: 106 });
    handlers.onQuote?.({ symbol, timestamp, bid: 105.99, ask: 106.01, bidSize: 10, askSize: 10 });
  };
  return { market, plan, data, symbols, emit, status: (status: StreamStatus) => handlers.onStatus?.(status, status), time: (at: number) => { time = at; } };
}

describe('Robot market request reduction', () => {
  it('observes twenty Wick robots with one shared assets/calendar read and no REST quotes or bars', async () => {
    const h = setup(), wick = inputFixture(wickCapture).approved.plan;
    for (const symbol of h.symbols) { h.emit(symbol); const snapshot = await h.market.snapshot({ ...wick, symbol }); expect(snapshot.quote?.priceUsd).toBe(106); }
    expect(h.data.getEligibleAssets).toHaveBeenCalledOnce(); expect(h.data.getCalendar).toHaveBeenCalledOnce();
    expect(h.data.getResearchQuotes).not.toHaveBeenCalled(); expect(h.data.getBars).not.toHaveBeenCalled();
  });
  it('keeps five-second quote observations while fetching strategy bars only once within a five-minute bucket', async () => {
    const h = setup();
    for (let tick = 0; tick < 12; tick++) {
      h.time(NOW + 6000 + tick * 5000); h.emit();
      const snapshot = await h.market.snapshot(h.plan);
      expect(snapshot.quote?.at).toBe(new Date(NOW + 6000 + tick * 5000).toISOString());
    }
    expect(h.data.getBars).toHaveBeenCalledOnce(); expect(h.data.getResearchQuotes).not.toHaveBeenCalled();
    expect(h.data.getCalendar).toHaveBeenCalledOnce(); expect(h.data.getEligibleAssets).toHaveBeenCalledTimes(3);
  });
  it('retains fresh quotes and shared caches across scanner subscription changes, but waits for acknowledgement', async () => {
    const h = setup(); h.emit(); await h.market.snapshot(h.plan);
    for (let tick = 1; tick <= 3; tick++) {
      h.time(NOW + 6000 + tick * 5000);
      h.status('subscribing'); expect(h.market.ready()).toBe(false);
      await expect(h.market.snapshot(h.plan)).rejects.toBeInstanceOf(MarketDataUnavailableError);
      h.status('ready'); expect((await h.market.snapshot(h.plan)).quote?.priceUsd).toBe(106);
    }
    expect(h.data.getEligibleAssets).toHaveBeenCalledOnce(); expect(h.data.getCalendar).toHaveBeenCalledOnce();
    expect(h.data.getBars).toHaveBeenCalledOnce(); expect(h.data.getResearchQuotes).not.toHaveBeenCalled();
    h.time(NOW + 37_000); h.status('subscribing'); h.status('ready');
    await h.market.snapshot(h.plan); expect(h.data.getResearchQuotes).toHaveBeenCalledOnce();
    expect(h.data.getEligibleAssets).toHaveBeenCalledTimes(2);
  });
  it('falls back to REST for stale stream facts, keeps newer stream events, and rejects stale responses', async () => {
    const h = setup(); h.emit(); h.time(NOW + 37_000);
    h.data.getResearchQuotes.mockImplementationOnce(async () => {
      h.emit(); return { [h.plan.symbol]: { price: 90, bid: 89, ask: 91, tradeAt: new Date(NOW).toISOString(), quoteAt: new Date(NOW).toISOString() } };
    });
    expect((await h.market.snapshot(h.plan)).quote?.priceUsd).toBe(106);
    expect(h.data.getResearchQuotes).toHaveBeenCalledOnce();
    h.status('disconnected'); h.status('ready');
    h.data.getResearchQuotes.mockResolvedValue({ [h.plan.symbol]: { price: 90, bid: 89, ask: 91, tradeAt: new Date(NOW).toISOString(), quoteAt: new Date(NOW).toISOString() } });
    expect((await h.market.snapshot(h.plan)).quote).toBeNull();
    expect(h.data.getCalendar).toHaveBeenCalledTimes(2);
  });
  it('treats a reconnect during an observation as a temporary feed gap and discards prior-generation data', async () => {
    const h = setup(); h.emit(); let release!: () => void;
    h.data.getCalendar.mockImplementationOnce(async () => { await new Promise<void>(resolve => { release = resolve; }); return []; });
    const request = h.market.snapshot(h.plan);
    h.status('disconnected'); h.status('ready'); h.emit(); release();
    await expect(request).rejects.toBeInstanceOf(MarketDataUnavailableError);
    expect((await h.market.snapshot(h.plan)).quote?.priceUsd).toBe(106);
    expect(h.data.getCalendar).toHaveBeenCalledTimes(2);
  });
});
