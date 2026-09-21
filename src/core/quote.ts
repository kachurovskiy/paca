import type { StockFeed } from './stream';
import { isOvernightTime } from './trading-session';

export interface ExecutionQuote {
  symbol: string;
  price: number | null;
  bid: number | null;
  ask: number | null;
  tradeAt: number | null;
  quoteAt: number | null;
  receivedAt: number;
  feed: StockFeed;
}

export function freshQuote(quote: ExecutionQuote | null, now: number, kind: 'market' | 'limit', robot = false): boolean {
  const fresh = (at: number | null, age: number) => at !== null && Number.isFinite(at) && at <= now + (robot ? 0 : 5000) && now - at <= age;
  const positive = (value: number | null) => value !== null && Number.isFinite(value) && value > 0;
  if (!quote || !fresh(quote.receivedAt, 30_000) || robot && quote.feed !== (isOvernightTime(now) ? 'boats' : 'sip')) return false;
  const trade = positive(quote.price) && fresh(quote.tradeAt, robot ? 30_000 : 90_000);
  const book = positive(quote.bid) && positive(quote.ask) && quote.bid! <= quote.ask! && fresh(quote.quoteAt, 30_000);
  return robot ? trade && book : kind === 'limit' ? book : trade;
}
