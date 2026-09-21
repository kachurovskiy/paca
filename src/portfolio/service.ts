import type { AccountReads } from '../broker/capabilities';
import type { MarketReads } from '../broker/reads';
import type { Account, AccountObservation, MarketClock, Order, Period, PortfolioHistory, Position, TradeActivity } from '../core/types';
import type { Run } from '../trading/records';
import { reconstructTrades } from './trades';
import { aggregateTradeHistory } from './analytics';
import { aggregateTickerHistory } from './tickers';
import { executionOutcomeFacts } from './accounting';

export interface PortfolioModel {
  account: Account | null; positions: readonly Position[]; orders: readonly Order[]; clock: MarketClock | null;
  syncedAt: number | null; error: string; history: PortfolioHistory | null; historyError: string;
  activities: readonly TradeActivity[]; activitiesComplete: boolean; activitiesError: string; historyRuns: readonly Run[];
}
export class Portfolio {
  model: PortfolioModel = { account: null, positions: [], orders: [], clock: null, syncedAt: null, error: '',
    history: null, historyError: '', activities: [], activitiesComplete: false, activitiesError: '', historyRuns: [] };
  private disposed = false;
  private loadingActivities = false;
  private historyRequest = 0;
  private listeners = new Set<() => void>();
  private readonly unwatchAccount: () => void;
  constructor(private readonly reads: Pick<AccountReads, 'getTradeActivities'>, private readonly market: MarketReads,
    private readonly readHistory: () => Promise<Run[]>, private readonly execution: {
      readonly model: { observation: AccountObservation | null; reconciliationError: string | null };
      subscribe(listener: () => void): () => void; reconcile(): Promise<void>;
    }, private readonly now: () => number = Date.now) {
    const update = () => {
      const { observation, reconciliationError } = execution.model;
      this.publish({ ...(observation ? { account: observation.account, positions: observation.positions, orders: observation.orders,
        clock: observation.clock, syncedAt: observation.at } : {}), error: reconciliationError ?? '' });
    };
    this.unwatchAccount = execution.subscribe(update); update();
  }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private publish(patch: Partial<PortfolioModel>): void {
    if (this.disposed) return; this.model = { ...this.model, ...patch }; for (const listener of this.listeners) listener();
  }
  async refresh(): Promise<void> {
    if (this.disposed) return;
    try { await this.execution.reconcile(); }
    catch (error) { this.publish({ error: error instanceof Error ? error.message : 'Account observations unavailable.' }); }
  }
  async performance(period: Period): Promise<void> {
    const request = ++this.historyRequest;
    try { const history = await this.market.getPortfolioHistory(period); if (request === this.historyRequest) this.publish({ history, historyError: '' }); }
    catch (error) { if (request === this.historyRequest) this.publish({ history: null, historyError: error instanceof Error ? error.message : 'Performance unavailable.' }); }
  }
  async history(): Promise<void> {
    if (this.disposed || this.loadingActivities) return; this.loadingActivities = true;
    const values = new Map<string, TradeActivity>();
    try {
      let pageToken: string | undefined, complete = false;
      for (let page = 0; page < 100; page++) {
        const result = await this.reads.getTradeActivities({ pageToken }); if (this.disposed) return;
        for (const activity of result.activities) values.set(activity.id, activity);
        if (!result.nextPageToken) { complete = true; break; }
        if (result.nextPageToken === pageToken) throw new Error('History cursor repeated; import is incomplete.');
        pageToken = result.nextPageToken;
      }
      this.publish({ activities: [...values.values()], activitiesComplete: complete, activitiesError: complete ? '' : 'History exceeded the page limit; results are partial.' });
    } catch (error) { this.publish({ activities: [...values.values()], activitiesComplete: false, activitiesError: error instanceof Error ? error.message : 'Trade history unavailable.' }); }
    finally { this.loadingActivities = false; }
    try { this.publish({ historyRuns: await this.readHistory() }); }
    catch (error) { this.publish({ activitiesError: error instanceof Error ? error.message : 'Execution history unavailable.' }); }
  }
  projection(timeZone: string) {
    const trades = reconstructTrades(this.model.activities);
    const fresh = this.model.syncedAt !== null && this.now() - this.model.syncedAt <= 30_000;
    return { trades, summary: aggregateTradeHistory(trades, timeZone), complete: this.model.activitiesComplete,
      tickers: aggregateTickerHistory(trades.trades, symbol => fresh ? this.model.positions.find(position => position.symbol === symbol)?.currentPrice : null) };
  }
  async outcomeFacts(active: readonly Run[]) {
    const ended = await this.readHistory(), at = new Date(this.now()).toISOString();
    if (this.disposed) throw new Error('This portfolio session is closed.');
    return [...active.filter(run => run.active), ...ended].map(run => executionOutcomeFacts(run, at));
  }
  dispose(): void { this.disposed = true; this.unwatchAccount(); this.listeners.clear(); this.historyRequest++; }
}
