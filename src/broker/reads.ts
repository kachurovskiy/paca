import type { ResearchQuote, ScannerAsset, ScannerBarsRequest, ScannerDiscovery, ScannerSnapshot } from '../core/market-data';
import type { OwnerSubscriptions, StreamHandlers } from '../core/stream';
import type { Bar, Period, PortfolioHistory, Quote, Timeframe } from '../core/types';
import type { ScannerBar, ScannerSession } from '../scanner/types';

export interface MarketReads {
  getSnapshots(symbols: string[]): Promise<Record<string, Quote>>;
  getBars(symbol: string, timeframe: Timeframe, options?: { extendedHistory?: boolean; includeOvernight?: boolean; signal?: AbortSignal; start?: string }): Promise<Bar[]>;
  getPortfolioHistory(period: Period): Promise<PortfolioHistory>;
}
export interface DataReads {
  readonly optionalStatusCapability: 'unsupported';
  getCalendar(start: string, end: string, signal?: AbortSignal): Promise<ScannerSession[]>;
  getEligibleAssets(signal?: AbortSignal): Promise<ScannerAsset[]>;
  getBars(symbols: string[], options: ScannerBarsRequest, signal?: AbortSignal): Promise<Record<string, ScannerBar[]>>;
  getDiscovery(session: ScannerSession, now: number, signal?: AbortSignal): Promise<ScannerDiscovery>;
  getSnapshots(symbols: string[], signal?: AbortSignal): Promise<Record<string, ScannerSnapshot>>;
  getResearchQuotes(symbols: string[], signal?: AbortSignal): Promise<Record<string, ResearchQuote>>;
  getSplitFingerprint(symbols: string[], start: string, end: string, signal?: AbortSignal): Promise<Record<string, string>>;
}
export interface MarketStream {
  addListener(handlers: Partial<StreamHandlers>): () => void;
  setOwnerSubscriptions(owner: string, subscriptions: OwnerSubscriptions): void;
  removeOwner(owner: string): void;
}
