import { tradingDate } from '../core/exchange-session';
import { isOvernightTime } from '../core/trading-session';
import type { AccountReads } from '../broker/capabilities';
import type { DataReads } from '../broker/reads';
import { ScannerCache } from '../market/cache';
import { isWorkingOrder } from '../core/orders';
import type { AccountScope } from '../core/account';
import type { RobotProposal } from './domain';
import { ResearchDocuments, type ResearchDocument, type ProposalDocument } from './documents';
import type { ExecutionOutcomeFacts } from './outcome-facts';
import { accountKey } from '../core/account';
import { forecastOffer, outcome } from './research/outcomes';
import type { Bar } from '../core/types';
import type { ResearchQuote } from '../core/market-data';
import { UniverseService, type UniverseContext } from './research/universe';
import { TrendResearchScheduler } from './research/scheduler';
import { TREND_RESEARCH_POLICY } from './research/trend';
import { researchWick } from './research/wick';
import { researchMean } from './research/mean-service';
import { allocatePortfolio, ALLOCATION_POLICY } from './portfolio/allocation';
import { opportunityKey } from './validation';
import type { PortfolioInput } from './portfolio/snapshot';

export interface ResearchModel { busy: boolean; message: string; proposals: readonly RobotProposal[]; documents: readonly ResearchDocument[]; candidates: readonly { symbol: string; template: string; status: string; reason: string }[] }
export class Research {
  model: ResearchModel = { busy: false, message: 'Research has not run.', proposals: [], documents: [], candidates: [] };
  private disposed = false;
  private readonly controller = new AbortController();
  private readonly universe: UniverseService;
  private readonly trend: TrendResearchScheduler;
  private listeners = new Set<() => void>();
  private loadRequest = 0;
  constructor(private readonly scope: AccountScope, private readonly data: DataReads, private readonly account: AccountReads,
    private readonly documents: ResearchDocuments, cache: ScannerCache, private readonly ready: () => boolean,
    private readonly localPortfolio: () => Pick<PortfolioInput, 'uncertain' | 'commitments'>, private readonly readExecutionOutcomes: () => Promise<readonly ExecutionOutcomeFacts[]>,
    private readonly now: () => number = Date.now) {
    this.universe = new UniverseService(data, cache, now);
    this.trend = new TrendResearchScheduler(data, now);
  }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private publish(patch: Partial<ResearchModel>): void { if (!this.disposed) { this.model = { ...this.model, ...patch }; for (const listener of this.listeners) listener(); } }
  async load(): Promise<void> {
    const request = ++this.loadRequest;
    try {
      const documents = await this.documents.load();
      if (request === this.loadRequest) this.publish({ documents, proposals: documents.flatMap(row => row.kind === 'proposal' && !row.dismissed ? [row.proposal] : []) });
    } catch (error) { this.publish({ message: error instanceof Error ? error.message : 'Research documents unavailable.' }); }
  }
  async dismiss(id: string): Promise<void> {
    const plan = this.model.proposals.find(plan => plan.id === id); if (!plan || this.disposed) return;
    await this.documents.saveProposal(plan, undefined, true); await this.load();
  }
  async discover(): Promise<void> {
    if (this.model.busy || this.disposed) return;
    if (!this.ready()) {
      this.publish({ message: 'Research requires a connected account and current real-time market feed.' }); return;
    }
    this.publish({ busy: true, message: 'Loading broad liquidity discovery and bounded strategy research…' });
    const at = () => new Date(this.now()).toISOString();
    try {
      const history = (await this.documents.load()).filter(row => row.kind === 'proposal');
      const context: UniverseContext = { scope: this.scope, connectionGeneration: 1, tradingDate: tradingDate(this.now()),
        data: { status: 'available', feed: isOvernightTime(this.now()) ? 'boats' : 'sip', asOf: at(), validUntil: new Date(this.now() + 60_000).toISOString(),
          provenanceRef: `${isOvernightTime(this.now()) ? 'boats' : 'sip'}/${at()}`, capabilities: ['completed_5min_bars', 'observed_prices', 'bid_ask'] } };
      this.universe.setContext(context);
      const universe = await this.universe.capture(`universe-${crypto.randomUUID()}`, this.controller.signal);
      if (this.disposed) return;
      if (universe.status !== 'available') { this.publish({ message: universe.blocks.map(block => block.reason).join(' ') }); return; }
      const snapshot = universe.snapshot;
      const wick = researchWick(snapshot, at());
      this.trend.setContext(context);
      const [trend, mean] = await Promise.all([this.trend.schedule(snapshot), researchMean(snapshot, this.data, this.documents, this.controller.signal, this.now)]);
      if (this.disposed) return;
      const batches = [...(trend.status === 'complete' ? [trend.batch] : []), wick, mean];
      // Keep failed/limited strategies visible even if allocation reads also fail.
      this.publish({ candidates: [...(trend.status === 'complete' ? [] : snapshot.candidates.map(row => ({ symbol: row.asset.symbol,
        template: TREND_RESEARCH_POLICY.id, status: 'unavailable', reason: trend.reason }))),
        ...batches.flatMap(batch => batch.evaluations.map(row => ({ symbol: row.symbol,
          template: batch.policy.id, status: row.status, reason: row.reason })))], message: 'Refreshing quotes and account capacity for selected strategies…' });
      const symbols = [...new Set(batches.flatMap(batch => batch.evaluations.flatMap(row => row.candidate ? [row.symbol] : [])))];
      const [account, positions, observedOrders, quotes] = await Promise.all([this.account.getAccount(), this.account.getPositions(), this.account.getOrders(),
        symbols.length ? this.data.getResearchQuotes(symbols, this.controller.signal) : Promise.resolve<Record<string, ResearchQuote>>({})]);
      if (this.disposed) return;
      if (!this.ready() || tradingDate(this.now()) !== snapshot.session.tradingDate
        || context.data.feed !== (isOvernightTime(this.now()) ? 'boats' : 'sip')) throw new Error('The market-data session changed during research. Run research again with the current feed.');
      const orders = observedOrders.filter(order => isWorkingOrder(order.status)), current = at(), local = this.localPortfolio(), clear = !local.uncertain;
      const allocation = allocatePortfolio({ evaluatedAt: current,
        portfolio: { id: `portfolio-${crypto.randomUUID()}`, scope: this.scope, asOf: current, validUntil: new Date(this.now() + 30_000).toISOString(),
          brokerSourceRef: `account/${current}`, localSourceRef: `local/${current}`, complete: { broker: true, local: clear, reconciliation: clear },
          account, positions, orders, commitments: local.commitments, uncertain: local.uncertain },
        research: batches[0], alternatives: batches.slice(1), sizing: snapshot.candidates.map(candidate => {
          const liquidity = snapshot.liquidity.find(row => row.symbol === candidate.asset.symbol), quote = quotes[candidate.asset.symbol];
          return { scope: this.scope, symbol: candidate.asset.symbol, sourceRef: `allocation-quotes/${current}`, asOf: quote?.tradeAt ?? current,
            validUntil: new Date(Date.parse(quote?.tradeAt ?? current) + 30_000).toISOString(), priceUsd: quote?.tradeAt ? quote.price : null,
            averageDailyDollarVolumeUsd: liquidity?.meanDailyDollars ?? null, liquidityComplete: !!liquidity && !liquidity.blocks.length,
            stressedLossBps: ALLOCATION_POLICY.minimumCandidateStressBps, stressRationale: ALLOCATION_POLICY.rationale };
        }) });
      for (const draft of allocation.drafts) {
        const plan: RobotProposal = { ...draft, schemaVersion: 1, scope: this.scope, id: `proposal-${crypto.randomUUID()}`, revision: 1, opportunityKey: '' };
        const proposal = { ...plan, opportunityKey: opportunityKey(plan) };
        const batch = batches.find(batch => batch.policy.id === proposal.evidence.policy.id);
        if (!batch) throw new Error('The offer has no matching research evidence.');
        const candidate = snapshot.candidates.find(row => row.asset.symbol === proposal.symbol), liquidity = snapshot.liquidity.find(row => row.symbol === proposal.symbol);
        const document: ProposalDocument = { key: JSON.stringify([accountKey(this.scope), proposal.id]), scope: accountKey(this.scope),
          kind: 'proposal', proposal, dismissed: false, outcome: null,
          features: { asOf: snapshot.dataCutoff, priceUsd: candidate?.quote?.price ?? null, dailyLiquidityUsd: liquidity?.meanDailyDollars ?? null },
          costs: batch.policy.assumptions, inputSymbols: batch.counts.inputSymbols, testedConfigurations: batch.counts.testedCandidates };
        const forecasted = await forecastOffer(document, history);
        if (this.disposed) return;
        await this.documents.saveProposal(forecasted, document);
      }
      this.publish({ message: allocation.drafts.length ? 'Review the exact plan and ceiling before approval. Proposals reserve no capital.'
          : [...new Set([...allocation.blocks.map(block => block.reason), ...allocation.candidates.flatMap(row => row.blocks.map(block => block.reason))])].join(' ') || 'No strategy qualified. Evidence remains unavailable.' });
      await this.load();
    } catch (error) { this.publish({ message: error instanceof Error ? error.message : 'Research unavailable. Execution reconciliation remains available.' }); }
    finally { this.publish({ busy: false }); }
  }
  async refreshOutcomes(): Promise<void> {
    if (this.model.busy || this.disposed) return;
    this.publish({ busy: true, message: 'Loading current-version outcomes and their completeness evidence…' });
    try {
      const [documents, executions] = await Promise.all([this.documents.load(), this.readExecutionOutcomes()]);
      let requests = 0, inspected = 0;
      for (const document of documents) {
        if (document.kind !== 'proposal' || document.proposal.session.closeAt > new Date(this.now()).toISOString()
          || document.outcome?.completeness === 'complete' || inspected++ >= 30) continue;
        const plan = document.proposal, actual = executions.find(value => value.proposalId === plan.id) ?? null;
        if (['paper_execution', 'live_execution'].includes(document.outcome?.provenance ?? '') && !actual) continue;
        let bars: Bar[] = [];
        if (!actual && plan.template.id === 'trend-following' && requests < 4) {
          requests++;
          try { bars = (await this.data.getBars([plan.symbol], { timeframe: '5Min', start: Date.parse(plan.session.openAt),
            end: Date.parse(plan.session.closeAt), maxPagesPerBatch: 2, maxBarsPerSymbol: 80 }, this.controller.signal))[plan.symbol] ?? []; }
          catch { /* The outcome records unavailable history explicitly. */ }
        }
        if (this.disposed) return;
        const result = outcome(document, actual, bars, new Date(this.now()).toISOString());
        if (result) await this.documents.saveOutcome(plan.id, result);
      }
      await this.load(); this.publish({ message: 'Outcome review updated. Missing fees, history and supervision remain explicit exclusions.' });
    } catch (error) { this.publish({ message: error instanceof Error ? error.message : 'Outcome evidence is unavailable.' }); }
    finally { this.publish({ busy: false }); }
  }
  export(): string { return JSON.stringify({ contract: 'paca-snapshots-1', research: this.model.documents }, null, 2); }
  dispose(): void { this.disposed = true; this.loadRequest++; this.controller.abort(); this.universe.dispose(); this.trend.dispose(); this.listeners.clear(); }
}
