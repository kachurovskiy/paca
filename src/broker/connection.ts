import { type StockFeed } from '../core/stream';
import type { Credentials } from '../core/types';
import { AlpacaApi } from './alpaca';
import { type AccountReads, type BrokerMutations } from './capabilities';
import { ScannerDataApi } from './market-data';
import type { DataReads, MarketReads, MarketStream } from './reads';
import { AlpacaStream } from './stream';
import { ApiActivity } from '../core/api-activity';

function dataFacade(api: ScannerDataApi): DataReads {
  return Object.freeze({ optionalStatusCapability: 'unsupported' as const,
    getCalendar: api.getCalendar.bind(api), getEligibleAssets: api.getEligibleAssets.bind(api),
    getBars: api.getBars.bind(api), getDiscovery: api.getDiscovery.bind(api),
    getSnapshots: api.getSnapshots.bind(api), getResearchQuotes: api.getResearchQuotes.bind(api),
    getSplitFingerprint: api.getSplitFingerprint.bind(api) });
}

/** Credentials and concrete clients never leave this adapter. Facades are actual objects. */
export function createBroker(credentials: Credentials, feed: StockFeed = 'sip') {
  const activity = new ApiActivity();
  const api = new AlpacaApi(credentials, activity);
  const bulk = new ScannerDataApi(credentials, { activity });
  // Execution reads have independent capacity; a full scanner queue cannot delay them.
  const critical = new ScannerDataApi(credentials, { maxConcurrency: 2, minRequestIntervalMs: 0, maxRetries: 1, activity });
  const socket = new AlpacaStream(credentials, { onStatus: () => {}, onTrade: () => {}, onQuote: () => {} }, feed);
  const account: AccountReads = Object.freeze({ getAccount: api.getAccount.bind(api), getPositions: api.getPositions.bind(api),
    getOrders: api.getOrders.bind(api), getOrder: api.getOrder.bind(api), getOrderByClientOrderId: api.getOrderByClientOrderId.bind(api),
    getTradeActivities: api.getTradeActivities.bind(api), getClock: api.getClock.bind(api) });
  const market: MarketReads = Object.freeze({ getSnapshots: api.getSnapshots.bind(api),
    getBars: api.getBars.bind(api), getPortfolioHistory: api.getPortfolioHistory.bind(api) });
  const mutations: BrokerMutations = Object.freeze({ submitOrder: api.submitOrder.bind(api), cancelOrder: api.cancelOrder.bind(api) });
  const stream: MarketStream = Object.freeze({ addListener: socket.addListener.bind(socket),
    setOwnerSubscriptions: socket.setOwnerSubscriptions.bind(socket), removeOwner: socket.removeOwner.bind(socket) });
  return { activity, account, market, mutations, stream, data: dataFacade(bulk), criticalData: dataFacade(critical),
    routeFeed: socket.setFeed.bind(socket),
    connect: (symbols: string[]) => socket.connect(symbols.length ? symbols : ['SPY']),
    stopReads: () => { api.abortReads(); bulk.dispose(); critical.dispose(); socket.dispose(); },
    dispose: () => api.dispose() };
}
