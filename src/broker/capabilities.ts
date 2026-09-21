import type { Account, MarketClock, Order, OrderRequest, Position, TradeActivitiesPage } from '../core/types';

export interface AccountReads {
  getAccount(): Promise<Account>;
  getPositions(): Promise<Position[]>;
  getOrders(): Promise<Order[]>;
  getOrder(id: string): Promise<Order>;
  getOrderByClientOrderId(id: string): Promise<Order | null>;
  getTradeActivities(options?: { after?: string; pageToken?: string }): Promise<TradeActivitiesPage>;
  getClock(): Promise<MarketClock>;
}

/** Only the account executor receives an instance of this capability. */
export interface BrokerMutations {
  submitOrder(request: OrderRequest): Promise<Order>;
  cancelOrder(id: string): Promise<void>;
}

export class BrokerWriteError extends Error {
  constructor(message: string, readonly uncertain: boolean) { super(message); }
}
