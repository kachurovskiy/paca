import { createBroker } from '../broker/connection';
import { openDatabase, type Database } from '../core/database';
import type { Credentials } from '../core/types';
import { isOvernightTime } from '../core/trading-session';
import { Market } from '../market/service';
import { ScannerCache } from '../market/cache';
import { ScannerFeature } from '../scanner/feature';
import { Portfolio } from '../portfolio/service';
import { Research } from '../robots/service';
import { ResearchDocuments } from '../robots/documents';
import { Trading } from '../trading/executor';
import { AccountOwnership } from '../trading/ownership';
import { accountKey } from '../core/account';
import { ExecutionStore } from '../trading/storage';

/** Composition and lifetime only. Services own their state, policy and subscriptions. */
export class Session {
  get apiActivity() { return this.broker.activity; }
  readonly id = crypto.randomUUID();
  private disposed = false;
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly unwatchRuns: () => void;
  private readonly unwatchPositions: () => void;
  private watched: string[] = [];
  private constructor(readonly environment: 'paper' | 'live', readonly accountId: string,
    readonly market: Market, readonly portfolio: Portfolio, readonly scanner: ScannerFeature,
    readonly research: Research, readonly trading: Trading, private readonly broker: ReturnType<typeof createBroker>, private readonly db: Database) {
    this.timer = setInterval(() => { void trading.tick().catch(() => {}); }, 5000);
    this.unwatchRuns = trading.subscribe(() => this.watch(this.watched));
    this.unwatchPositions = portfolio.subscribe(() => this.watch(this.watched));
  }
  static async connect(credentials: Credentials, symbols: string[], signal: AbortSignal): Promise<Session> {
    const feed = isOvernightTime() ? 'boats' : 'sip';
    const broker = createBroker(credentials, feed);
    let owner: AccountOwnership | null = null, db: Database | null = null, session: Session | null = null;
    const active = () => { if (signal.aborted) throw new DOMException('Connection cancelled.', 'AbortError'); };
    const abort = () => broker.stopReads(); signal.addEventListener('abort', abort, { once: true });
    try {
      active(); const account = await broker.account.getAccount(); active();
      if (!account.id) throw new Error('The broker returned no stable account identity.');
      const scope = { broker: 'alpaca', accountId: account.id, environment: credentials.environment };
      owner = await AccountOwnership.acquire(scope); active(); db = await openDatabase(); active();
      const storage = new ExecutionStore(db), cache = new ScannerCache();
      const market = new Market(broker.market, broker.criticalData, broker.stream, broker.routeFeed);
      const trading = new Trading(owner, broker.account, broker.mutations, market, storage);
      const portfolio = new Portfolio(broker.account, broker.market, () => storage.getRunHistory(accountKey(scope)), trading);
      const scanner = new ScannerFeature(accountKey(scope), db, broker.data, broker.stream, cache);
      const research = new Research(scope, broker.data, broker.account, new ResearchDocuments(db, accountKey(scope)), cache,
        () => market.ready(), () => trading.allocationSnapshot(), () => portfolio.outcomeFacts(trading.model.runs));
      session = new Session(credentials.environment, account.id, market, portfolio, scanner, research, trading, broker, db);
      await trading.initialize(); active();
      await broker.connect(symbols); active(); session.watch(symbols);
      await portfolio.refresh(); active();
      void scanner.start(); void research.load();
      return session;
    } catch (error) {
      if (session) await session.dispose();
      else { broker.stopReads(); broker.dispose(); db?.close(); await owner?.release(); }
      throw error;
    } finally { signal.removeEventListener('abort', abort); }
  }
  watch(symbols: string[]): void {
    if (this.disposed) return; this.watched = symbols;
    this.market.watch([...symbols, ...this.portfolio.model.positions.map(position => position.symbol),
      ...this.trading.model.runs.filter(run => run.active).map(run => run.approved.plan.symbol)]);
  }
  async dispose(): Promise<void> {
    if (this.disposed) return; this.disposed = true;
    const settled = this.trading.dispose();
    clearInterval(this.timer); this.unwatchRuns(); this.unwatchPositions(); this.research.dispose(); this.scanner.dispose(); this.portfolio.dispose(); this.market.dispose();
    this.broker.stopReads();
    await settled; this.broker.dispose(); this.db.close();
  }
}
