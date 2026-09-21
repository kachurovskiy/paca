import type { Bar } from './types';


export type StreamStatus = 'connecting' | 'authenticating' | 'subscribing' | 'ready' | 'disconnected' | 'error';
export type StockFeed = 'sip' | 'boats';
export interface StreamTrade { symbol: string; price: number; timestamp: string; }
export interface StreamQuote { symbol: string; bid: number | null; ask: number | null; bidSize: number | null; askSize: number | null; timestamp: string; }
export interface StreamBar extends Bar { symbol: string; vw: number | null; revision: boolean; }
export interface StreamTradingStatus { symbol: string; statusCode: string; message: string; timestamp: string }
export type StatusCapability = 'disabled' | 'pending' | 'supported' | 'unsupported';
export interface StreamHandlers {
  onStatus: (status: StreamStatus, message: string) => void;
  onTrade: (trade: StreamTrade) => void;
  onQuote: (quote: StreamQuote) => void;
  onBar?: (bar: StreamBar) => void;
  onSubscriptionError?: (owner: string, message: string) => void;
  onTradingStatus?: (status: StreamTradingStatus) => void;
  onStatusCapability?: (owner: string, capability: StatusCapability) => void;
}

export type StreamChannel = 'trades' | 'quotes' | 'bars' | 'updatedBars' | 'statuses';
export type OwnerSubscriptions = Partial<Record<StreamChannel, string[]>>;
