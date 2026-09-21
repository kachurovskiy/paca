export type Environment = 'paper' | 'live';
export type Timeframe = '1Min' | '5Min' | '15Min' | '1Hour' | '1Day' | '1Week';
export type Period = '1D' | '1W' | '1M' | 'ALL';
export interface Account { /** Stable non-secret broker ID; missing identity blocks execution. */ id?: string | null; equity: number; lastEquity: number; buyingPower: number; regtBuyingPower?: number | null; cash: number; portfolioValue: number | null; daytradeCount: number | null; tradingBlocked: boolean; createdAt: string | null; }
export interface Position { symbol: string; qty: number; avgEntryPrice: number; currentPrice: number | null; marketValue: number | null; unrealizedPl: number | null; unrealizedPlpc: number | null; side: 'long' | 'short'; }
export interface Order { id: string; symbol: string; qty: number | null; filledQty: number | null; side: 'buy' | 'sell'; type: string; status: string; submittedAt: string; filledAvgPrice?: number; limitPrice?: number; stopPrice?: number; timeInForce?: string; orderClass?: string; extendedHours?: boolean; parentOrderId?: string; legs?: Order[]; clientOrderId?: string; filledAt?: string | null; updatedAt?: string | null; }
export interface TradeActivity { id: string; orderId: string; symbol: string; side: 'buy' | 'sell'; qty: number; price: number; transactionTime: string; type: string; feeUsd?: string | null; }
export interface TradeActivitiesPage { activities: TradeActivity[]; nextPageToken: string | null; }
export interface Bar { t: string; o: number; h: number; l: number; c: number; v: number; }
export interface Quote { symbol: string; price: number; previousClose: number | null; change: number | null; changePercent: number | null; bid: number | null; ask: number | null; volume: number | null; high: number | null; low: number | null; timestamp: string; }
export interface PortfolioHistory { timestamp: number[]; equity: number[]; profitLoss: number[]; profitLossPct: (number | null)[]; baseValue: number | null; }
export interface MarketClock { isOpen: boolean; timestamp: string; nextOpen: string; nextClose: string; }
export interface AccountObservation { account: Account; positions: Position[]; orders: Order[]; clock: MarketClock; at: number; }
export interface OrderRequest { symbol: string; qty: number; side: 'buy' | 'sell'; type: 'market' | 'limit' | 'stop'; limitPrice?: number; stopPrice?: number; timeInForce?: 'day' | 'gtc'; /** Attached OTO stop; submitted atomically with the entry. */ stopLoss?: { stopPrice: number }; extendedHours?: boolean; clientOrderId?: string; }
export interface Credentials { keyId: string; secretKey: string; environment: 'paper' | 'live'; }
