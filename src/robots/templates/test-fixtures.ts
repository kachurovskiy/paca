import type { Bar } from '../../core/types';
import type { MomentumParameters } from '../math/momentum';
import { proposalFixture } from '../test-fixtures';
import { opportunityKey } from '../validation';
import { initialTemplateState } from './common';
import { trendFollowing } from './trend-following';
import type { StrategyTemplate, TemplateInput } from './types';
import { VWAP_DEFAULTS } from './vwap-mean-reversion';

export const OPEN = Date.parse('2026-09-18T13:30:00.000Z');
export const NOW = OPEN + 30 * 60_000;
export const INTERVAL = 300_000;
export const iso = (time: number) => new Date(time).toISOString();
export const trendParameters: MomentumParameters = { fastPeriod: 2, slowPeriod: 4, stopLossPct: 2, trailingStopPct: 1 };
export type Mutable<T> = T extends object ? { -readonly [K in keyof T]: Mutable<T[K]> } : T;

/** Explicit synthetic prices and identities, never used by production code. */
export function bars(count = 8, step = 1): Bar[] {
  return Array.from({ length: count }, (_, index) => {
    const o = 100 + index * step, c = o + step;
    return { t: iso(OPEN + index * INTERVAL), o, c, h: Math.max(o, c) + 0.01, l: Math.min(o, c) - 0.01, v: 1000 };
  });
}

export function inputFixture(template: StrategyTemplate = trendFollowing): Mutable<TemplateInput> {
  const plan = proposalFixture() as Mutable<TemplateInput['approved']['plan']>;
  plan.template = { ...template.identity };
  plan.parameters = template.identity.id === 'trend-following' ? { ...trendParameters } : template.identity.id === 'vwap-mean-reversion' ? { ...VWAP_DEFAULTS } : { dipPct: 0.6, holdMinutes: 5 };
  plan.executionPolicy = { ...template.executionPolicy }; plan.exitPolicy = { ...template.exitPolicy };
  plan.opportunityKey = opportunityKey(plan);
  return {
    approved: { schemaVersion: 1, scope: { ...plan.scope }, id: 'approval-fixture', commandId: 'command-fixture',
      approvedAt: iso(NOW), plan },
    runId: 'run-fixture', decisionId: 'decision-fixture', evaluatedAt: iso(NOW),
    market: { inputRef: 'market-fixture', symbol: plan.symbol, dataCutoff: iso(NOW), session: { ...plan.session },
      assetClass: 'us_equity', capabilities: [...template.requiredCapabilities],
      quote: { at: iso(NOW), priceUsd: template.identity.id === 'vwap-mean-reversion' ? 99.3 : 106,
        bidUsd: template.identity.id === 'vwap-mean-reversion' ? 99.29 : 106, askUsd: template.identity.id === 'vwap-mean-reversion' ? 99.31 : 106 },
      bars: template.identity.id === 'vwap-mean-reversion' ? [100, 100.2, 99.8, 100.2, 99.8, 99.3].map((c, index) => ({
        t: iso(OPEN + index * INTERVAL), o: c, h: c + 0.1, l: c - 0.1, c, v: 10000 })) : bars() },
    owned: { quantity: 0, positionKey: null, averageEntryPriceUsd: null, entryAt: null, firstFillAt: null },
    execution: { workingOrders: [], pendingSubmission: false, uncertain: false, entriesAllowed: true, entryBlocks: [] },
    state: initialTemplateState(template.identity),
  };
}

export function observe(input: Mutable<TemplateInput>, time: number, price = 106): void {
  input.evaluatedAt = iso(time); input.market.dataCutoff = iso(time);
  input.market.quote = { at: iso(time), priceUsd: price, bidUsd: price, askUsd: price };
}

export function own(input: Mutable<TemplateInput>, quantity = 2, price = 106, at = NOW, key = 'position-fixture'): void {
  input.owned = { quantity, positionKey: key, averageEntryPriceUsd: price, entryAt: iso(at), firstFillAt: iso(at) };
}
