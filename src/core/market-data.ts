/** Temporary session/feed gaps should suspend a cycle without disarming approved supervision. */
export class MarketDataUnavailableError extends Error {}

export interface ScannerAsset { symbol: string; id: string; name: string; exchange: string; overnightTradable?: boolean }
export interface ScannerDiscovery { symbols: string[]; warnings: string[]; updatedAt: number | null; mostActiveCount: number; moversCount: number }
export interface ScannerSnapshot { previousClose: number | null }
/** Trade and bid/ask clocks stay separate; neither implies the other's freshness. */
export interface ResearchQuote {
  price: number | null; tradeAt: string | null;
  bid: number | null; ask: number | null; quoteAt: string | null;
}
export interface ScannerBarsRequest { feed?: 'sip' | 'boats'; includeOvernight?: boolean; start: number; end: number; timeframe: '1Min' | '5Min' | '1Day'; maxPagesPerBatch?: number; maxBarsPerSymbol?: number }
