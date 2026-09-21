import { testCipher } from '../core/vault-test-fixtures';
import 'fake-indexeddb/auto';
import { afterEach, expect, it, vi } from 'vitest';
import type { AccountReads } from '../broker/capabilities';
import type { DataReads } from '../broker/reads';
import { accountKey } from '../core/account';
import { openDatabase } from '../core/database';
import { ScannerCache } from '../market/cache';
import { ResearchDocuments } from './documents';
import { allocationFixture } from './portfolio/test-fixtures';
import { meanReversionFixture } from './research/mean-reversion-fixtures';
import { meanReversionBatch } from './research/mean-reversion';
import * as meanService from './research/mean-service';
import { TrendResearchScheduler } from './research/scheduler';
import { Research } from './service';

afterEach(() => vi.restoreAllMocks());

async function setup(mode: 'fresh' | 'stale' | 'missing' | 'missing_timestamp' | 'future' | 'failure' | 'disconnected' = 'fresh') {
  const f = meanReversionFixture(3), scope = f.context.scope;
  let time = f.now, quoteReads = 0, ready = true;
  const data: DataReads = { ...f.api, optionalStatusCapability: 'unsupported', getDiscovery: vi.fn(), getSnapshots: vi.fn(), getSplitFingerprint: vi.fn(),
    getBars: async (symbols, options, signal) => {
      const bars = await f.api.getBars(symbols, options, signal);
      return options.timeframe !== '1Day' ? bars : Object.fromEntries(Object.entries(bars).map(([symbol, rows]) => [symbol, rows.map(bar => ({ ...bar, v: 100_000_000 }))]));
    },
    getResearchQuotes: vi.fn(async (symbols: string[]) => {
      const allocation = ++quoteReads > 1;
      if (allocation && mode === 'failure') throw new Error('Quote refresh unavailable.');
      if (allocation && mode === 'missing') return {};
      const at = allocation && mode === 'missing_timestamp' ? null
        : new Date(allocation && mode !== 'stale' ? time + (mode === 'future' ? 1000 : 0) : f.now - 20_000).toISOString();
      const price = allocation ? 200 : 100;
      return Object.fromEntries(symbols.map(symbol => [symbol, { price, bid: price - .01, ask: price + .01, tradeAt: at, quoteAt: at }]));
    }) };
  const account: AccountReads = { getAccount: async () => ({ ...allocationFixture().portfolio.account, id: scope.accountId }),
    getPositions: async () => [], getOrders: async () => [], getOrder: vi.fn(), getOrderByClientOrderId: vi.fn(), getTradeActivities: vi.fn(), getClock: vi.fn() };
  vi.spyOn(TrendResearchScheduler.prototype, 'schedule').mockImplementation(async () => {
    time += 20_000; if (mode === 'disconnected') ready = false;
    return { status: 'failed', reasonCode: 'research_timeout', reason: 'The fixed research deadline elapsed' };
  });
  vi.spyOn(meanService, 'researchMean').mockImplementation(async snapshot => meanReversionBatch(snapshot, new Date(time).toISOString(), null, null, 0));
  const db = await openDatabase(await testCipher(), `research-service-${crypto.randomUUID()}`), documents = new ResearchDocuments(db, accountKey(scope));
  const research = new Research(scope, data, account, documents, new ScannerCache(), () => ready,
    () => ({ uncertain: false, commitments: [] }), async () => [], () => time);
  return { f, data, research, documents, close: () => { research.dispose(); db.close(); } };
}

it('refreshes one batch of allocation quotes after slow research and keeps Trend timeouts visible', async () => {
  const h = await setup();
  try {
    await h.research.discover();
    expect(h.research.model.proposals).toHaveLength(3);
    expect(h.data.getResearchQuotes).toHaveBeenCalledTimes(2); // Discovery plus one refresh, not one call per candidate.
    for (const plan of h.research.model.proposals) {
      expect(plan.rationale.join(' ')).toContain(`at ${new Date(h.f.now + 20_000).toISOString()}; preview quantity 4;`);
      expect(plan.dataCutoff).toBe(new Date(h.f.now).toISOString()); // Historical evidence keeps its original cutoff.
      expect(plan.validUntil).toBe(new Date(h.f.now + 50_000).toISOString());
    }
    expect(h.research.model.candidates.filter(row => row.template === 'trend-legacy-experimental')).toEqual(
      h.f.assets.map(asset => ({ symbol: asset.symbol, template: 'trend-legacy-experimental', status: 'unavailable', reason: 'The fixed research deadline elapsed' })));
    expect(h.research.model.message).not.toContain('stale_sizing');
  } finally { h.close(); }
});

it.each(['stale', 'missing', 'missing_timestamp', 'future', 'failure', 'disconnected'] as const)('keeps %s refreshed inputs from producing offers without falling back to discovery prices', async mode => {
  const h = await setup(mode);
  try {
    await h.research.discover();
    expect(h.research.model.proposals).toEqual([]);
    expect(h.research.model.candidates.filter(row => row.template === 'trend-legacy-experimental')).toHaveLength(3);
    expect(h.research.model.busy).toBe(false);
    if (mode === 'stale') expect(h.research.model.message).toContain('stale_sizing');
    if (mode === 'failure') expect(h.research.model.message).toBe('Quote refresh unavailable.');
    if (mode === 'disconnected') expect(h.research.model.message).toContain('session changed');
  } finally { h.close(); }
});
