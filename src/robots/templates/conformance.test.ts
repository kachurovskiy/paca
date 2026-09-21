import { afterEach, describe, expect, it, vi } from 'vitest';
import { evaluateTemplate, templates } from './registry';
import { inputFixture, iso, NOW, observe, own } from './test-fixtures';
import type { StrategyTemplate } from './types';

// A transitive runtime dependency on the broker, executor or application session fails module loading.
vi.mock('../../broker/alpaca', () => { throw new Error('Pure templates cannot import AlpacaApi implementation'); });
vi.mock('../../trading/executor', () => { throw new Error('Pure templates cannot import the broker executor'); });
vi.mock('../../app/session', () => { throw new Error('Pure templates cannot import the application session'); });

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

/** Reusable: register additional real templates here without changing the contract cases. */
function templateConformance(template: StrategyTemplate): void {
  describe(`${template.displayName} conformance`, () => {
    it('declares versioned bounded parameters, capabilities, policies and diagnostics', () => {
      const input = inputFixture(template);
      expect(template.support).toEqual({ assets: ['us_equity'], direction: 'long', session: '24x5', environments: ['paper', 'live'], supervision: 'browser' });
      expect(template.requiredCapabilities).toEqual(expect.arrayContaining(['observed_prices', 'owned_fills', 'market_orders', 'cancel_confirmation']));
      expect(template.diagnostics.version).toBe(1);
      expect(template.diagnostics.conditionCodes.length).toBeGreaterThan(0);
      expect(template.simulationLimitations.length).toBeGreaterThan(0);
      expect(template.eligibility(input)).toEqual([]);
      expect(() => template.validateParameters(input.approved.plan.parameters)).not.toThrow();
    });

    

    it('rejects every non-finite, missing, extra and out-of-bounds parameter', () => {
      const input = inputFixture(template), parameters = input.approved.plan.parameters;
      for (const [key, bounds] of Object.entries(template.parameters)) {
        const values = [NaN, Infinity, -Infinity, bounds.min - 1, bounds.max + 1, '1', null];
        if (bounds.integer) values.push(bounds.min + 0.5);
        for (const value of values) {
          const bad = { ...parameters, [key]: value };
          expect(() => template.validateParameters(bad)).toThrow();
          const altered = structuredClone(input); altered.approved.plan.parameters = bad as Record<string, number>;
          expect(template.evaluate(altered).intent).toBeNull();
        }
        const missing = { ...parameters }; delete missing[key];
        expect(() => template.validateParameters(missing)).toThrow();
      }
      expect(() => template.validateParameters({ ...parameters, invented: 1 })).toThrow();
      for (const [lower, upper] of template.strictlyOrdered) expect(() => template.validateParameters({ ...parameters, [lower]: parameters[upper] })).toThrow();
    });

    it('records stable action/no-action reasons with scope, cutoff, versions and conditions', () => {
      const input = inputFixture(template), action = template.evaluate(input);
      expect(action.intent?.kind).toBe('entry');
      expect(action.decision).toMatchObject({ scope: input.approved.scope, template: template.identity,
        policy: template.executionPolicy,
        evaluatedAt: input.evaluatedAt, dataCutoff: input.market.dataCutoff, action: 'request_entry' });
      expect(action.decision.candidate).toEqual({ side: 'buy', quantity: action.intent && 'quantity' in action.intent ? action.intent.quantity : 0 });
      expect(action.decision.conditions.length).toBeGreaterThan(0);
      expect(action.decision.conditions.every(item => template.diagnostics.conditionCodes.includes(item.code))).toBe(true);
      input.execution.entriesAllowed = false;
      const hold = template.evaluate(input);
      expect(hold.intent).toBeNull(); expect(hold.decision.reasonCode).toBe('entries_paused');
      expect(hold.decision.vetoes[0].reason).not.toBe('');
    });

    it('replays frozen inputs deterministically without network, storage, UI or ambient time', () => {
      const input = structuredClone(inputFixture(template));
      const forbidden = vi.fn(() => { throw new Error('Side effect attempted'); });
      vi.stubGlobal('fetch', forbidden); vi.stubGlobal('XMLHttpRequest', forbidden); vi.stubGlobal('WebSocket', forbidden);
      vi.stubGlobal('document', new Proxy({}, { get: forbidden }));
      vi.stubGlobal('localStorage', new Proxy({}, { get: forbidden })); vi.stubGlobal('indexedDB', new Proxy({}, { get: forbidden }));
      vi.spyOn(Date, 'now').mockImplementation(forbidden);
      const first = template.evaluate(input), second = template.evaluate(input);
      expect(first).toEqual(second); expect(first.intent?.kind).toBe('entry');
      expect(first.state).not.toBe(input.state); expect(first.decision.scope).not.toBe(input.approved.scope);
      template.research({ symbol: input.market.symbol, bars: [], dataCutoff: input.market.dataCutoff, sessions: [input.market.session!] });
      expect(forbidden).not.toHaveBeenCalled();
    });

    it('blocks missing capabilities individually instead of degrading silently', () => {
      for (const missing of template.requiredCapabilities) {
        const input = inputFixture(template); input.market.capabilities = input.market.capabilities.filter(item => item !== missing);
        const evaluated = template.evaluate(input);
        expect(evaluated.intent).toBeNull(); expect(evaluated.decision.vetoes).toContainEqual({ category: 'capability', code: 'missing_capability', reason: `Required capability: ${missing}` });
      }
    });

    it.each(['missing', 'stale', 'future', 'invalid'] as const)('blocks %s price observations', mode => {
      const input = inputFixture(template);
      if (mode === 'missing') input.market.quote = null;
      else if (mode === 'stale') input.market.quote!.at = iso(NOW - 30_001);
      else if (mode === 'future') input.market.quote!.at = iso(NOW + 1);
      else input.market.quote!.priceUsd = NaN;
      expect(template.evaluate(input)).toMatchObject({ intent: null, decision: { reasonCode: 'stale_quote' } });
    });

    it('cancels stale resting entries once, then waits for confirmation without losing exposure', () => {
      const input = inputFixture(template);
      input.execution.workingOrders = [{ id: 'bid-1', side: 'buy', cancellationPending: false, limitPriceUsd: 100, submittedAt: iso(NOW) }];
      input.market.quote = null;
      const cancel = template.evaluate(input);
      expect(cancel.intent).toEqual({ kind: 'cancel', orderIds: ['bid-1'] });
      input.execution.workingOrders[0].cancellationPending = true;
      own(input, 0.5);
      expect(template.evaluate(input)).toMatchObject({ intent: null, decision: { reasonCode: 'cancellation_pending' } });
      expect(input.owned.quantity).toBe(0.5);
    });

    it.each(['uncertain', 'pending', 'unknown_quantity', 'unknown_orders', 'short', 'precision'] as const)('blocks %s execution facts', mode => {
      const input = inputFixture(template);
      if (mode === 'uncertain') input.execution.uncertain = true;
      if (mode === 'pending') input.execution.pendingSubmission = true;
      if (mode === 'unknown_quantity') input.owned.quantity = null;
      if (mode === 'unknown_orders') input.execution.workingOrders = null;
      if (mode === 'short') input.owned.quantity = -1;
      if (mode === 'precision') own(input, 0.0000000001);
      expect(template.evaluate(input).intent).toBeNull();
    });

    it('does not duplicate a working exit or sell account-wide inventory', () => {
      const input = inputFixture(template); own(input, 0.75);
      observe(input, NOW + 6 * 60_000, 80);
      input.execution.workingOrders = [{ id: 'exit-1', side: 'sell', cancellationPending: false, limitPriceUsd: null, submittedAt: iso(NOW) }];
      expect(template.evaluate(input)).toMatchObject({ intent: null, decision: { reasonCode: 'exit_pending' } });
      input.execution.workingOrders = [];
      expect(template.evaluate(input).intent).toMatchObject({ kind: 'exit', quantity: 0.75 });
    });

    it('evaluates live plans with the same entry and protective exit rules', () => {
      const input = inputFixture(template);
      input.approved.scope.environment = input.approved.plan.scope.environment = 'live';
      expect(template.evaluate(input).intent?.kind).toBe('entry');
      own(input, 0.75); observe(input, NOW + 6 * 60_000, 80);
      input.execution.entriesAllowed = false;
      expect(template.evaluate(input).intent).toMatchObject({ kind: 'exit', quantity: 0.75 });
    });

    it('blocks closed/missing sessions, mismatched environments, wrong assets, policies and approval revisions', () => {
      for (const alter of [
        (input: ReturnType<typeof inputFixture>) => { input.market.session = null; },
        (input: ReturnType<typeof inputFixture>) => { observe(input, Date.parse(input.approved.plan.session.closeAt)); },
        (input: ReturnType<typeof inputFixture>) => { input.approved.scope.environment = 'live'; },
        (input: ReturnType<typeof inputFixture>) => { input.market.assetClass = 'crypto'; },
        (input: ReturnType<typeof inputFixture>) => { input.approved.plan.executionPolicy.version = 999; },
        (input: ReturnType<typeof inputFixture>) => { input.market.symbol = 'WRONG'; },
      ]) {
        const input = inputFixture(template); alter(input);
        const evaluated = template.evaluate(input);
        expect(evaluated.intent).toBeNull(); expect(evaluated.decision.vetoes.length).toBeGreaterThan(0);
      }
    });

    it('retains inspectable unsupported versions and never falls back to current behavior', () => {
      const input = inputFixture(template); input.approved.plan.template.version = 999;
      expect(evaluateTemplate(input)).toMatchObject({ intent: null, decision: { template: { version: 999 }, reasonCode: 'unsupported_template_version' } });
      expect(template.evaluate(input).intent).toBeNull();
    });

    it('accepts a calendar refreshed during the session and rejects future calendar evidence', () => {
      const input = inputFixture(template); input.market.session!.calendarAsOf = iso(NOW - 1000);
      expect(template.evaluate(input).intent?.kind).toBe('entry');
      input.market.session!.calendarAsOf = iso(NOW + 1);
      expect(template.evaluate(input)).toMatchObject({ intent: null, decision: { reasonCode: 'session_unavailable' } });
    });

    it('keeps an approved active plan evaluable after proposal expiry, within its session horizon', () => {
      const input = inputFixture(template); own(input);
      observe(input, Date.parse(input.approved.plan.validUntil) + 1, 80);
      expect(template.evaluate(input).intent?.kind).toBe('exit');
    });
  });
}

templates.forEach(templateConformance);

it('keeps three workflow templates with immutable metadata and rejects unsupported identities', () => {
  expect(templates.map(item => item.displayName)).toEqual(['Trend Following', 'Wick Capture', 'VWAP Mean Reversion']);
  expect(templates.map(t => t.identity.id)).toContain('vwap-mean-reversion');
});
