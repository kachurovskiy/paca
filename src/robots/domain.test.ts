import { describe, expect, it } from 'vitest';
import { quantityWithinBudget, validateQuantity } from '../core/precision';
import { DomainValidationError } from '../core/validation';
import { canonicalSerialize, snapshotProposal } from './research/values';
import { numericForecastFixture, proposalFixture, templateFixture } from './test-fixtures';
import { opportunityKey, validateProposal, validateScope } from './validation';

const templates = [templateFixture];

/** Change malformed wire values without bypassing the public unknown-input boundary. */
function corrupted(path: string, value: unknown): unknown {
  const proposal = JSON.parse(JSON.stringify(proposalFixture()));
  const keys = path.split('.');
  let parent = proposal;
  for (const key of keys.slice(0, -1)) parent = parent[key];
  parent[keys[keys.length - 1]] = value;
  return proposal;
}

describe('proposal boundary', () => {
  it('validates synthetic known parameters without changing the supplied object', () => {
    const proposal = structuredClone(proposalFixture());
    expect(() => validateProposal(proposal, templates)).not.toThrow();
    expect(() => validateProposal(JSON.parse(JSON.stringify(proposal)), templates)).not.toThrow();
  });

  it('creates detached, immutable revisions before approval', () => {
    const source = proposalFixture();
    const revision = snapshotProposal(source, templates);
    source.parameters.fastPeriod = 10;
    expect(revision.parameters.fastPeriod).toBe(5);
    
    
    
  });

  it.each([
    ['schemaVersion', 2], ['schemaVersion', '1'], ['template.version', 2], ['template.id', 'unknown'],
    ['id', ''], ['revision', 0], ['revision', 1.5], ['scope.accountId', ''], ['scope.accountId', 'account with spaces'],
    ['scope.environment', 'live'], ['scope.environment', 'sandbox'], ['direction', 'short'], ['sessionMode', 'extended'],
    ['supervision', 'server'], ['symbol', 'test'], ['opportunityKey', 'wrong'],
    ['parameters.fastPeriod', 1], ['parameters.fastPeriod', 20], ['parameters.fastPeriod', 5.5],
    ['parameters.stopLossPct', 0], ['parameters.slowPeriod', 61], ['parameters.extra', 1],
    ['capital.ceilingCents', 0], ['capital.ceilingCents', 1.1], ['capital.ceilingCents', 1_000_001],
    ['risk.budgetCents', -1], ['risk.lossTriggerCents', 100_001], ['exitPolicy.version', 0],
    ['session.timeZone', 'Europe/Berlin'], ['session.tradingDate', '2026-09-19'], ['session.closeAt', '2026-09-18T13:00:00.000Z'],
    ['generatedAt', '2026-02-30T13:55:00.000Z'], ['generatedAt', '2026-09-18T13:55:00Z'],
    ['dataCutoff', '2026-09-18T13:56:00.000Z'], ['validUntil', '2026-09-18T13:55:00.000Z'],
    ['validUntil', '2026-09-18T19:46:00.000Z'], ['intendedEnd', '2026-09-18T20:01:00.000Z'],
    ['entryWindow.from', '2026-09-18T13:00:00.000Z'], ['entryWindow.to', '2026-09-18T14:00:00.000Z'],
    ['session.calendarAsOf', '2026-09-18T13:56:00.000Z'], ['capital.snapshotAt', '2026-09-18T13:56:00.000Z'],
    ['evidence.dataCutoff', '2026-09-18T13:51:00.000Z'], ['evidence.status', 'trusted'],
    ['adaptationBounds', { delay: { min: 2, max: 1 } }], ['adaptationBounds', { delay: { min: -1, max: 1 } }],
    ['blocks', [{ category: 'data', code: 'missing', reason: '' }]],
  ])('rejects malformed %s = %s without coercion', (path, value) => {
    expect(() => validateProposal(corrupted(path, value), templates)).toThrow(DomainValidationError);
  });

  it.each([NaN, Infinity, -Infinity, -1])('rejects invalid numeric inputs %s', value => {
    for (const path of ['capital.ceilingCents', 'capital.equityCents', 'risk.budgetCents', 'risk.lossTriggerCents', 'parameters.stopLossPct']) {
      expect(() => validateProposal(corrupted(path, value), templates)).toThrow(DomainValidationError);
    }
  });

  it('fails closed without a supported template and never empties a corrupt payload', () => {
    const input = { ...proposalFixture(), unexpected: 'retain me' };
    expect(() => validateProposal(input, templates)).toThrow('unexpected_or_missing_fields');
    expect(input.unexpected).toBe('retain me');
    expect(() => validateProposal(proposalFixture(), [])).toThrow('unsupported_or_ambiguous_template');
    expect(() => validateProposal(proposalFixture(), [templateFixture, templateFixture])).toThrow('unsupported_or_ambiguous_template');
    expect(() => validateProposal(null, templates)).toThrow(DomainValidationError);
  });

  it('accepts live plans only with their own environment-specific opportunity identity', () => {
    const original = proposalFixture(), scope = { ...original.scope, environment: 'live' as const };
    const proposal = { ...original, scope };
    expect(() => validateScope(scope)).not.toThrow();
    expect(() => validateProposal(proposal, templates)).toThrow('opportunity_mismatch');
    expect(() => validateProposal({ ...proposal, opportunityKey: opportunityKey(proposal) }, templates)).not.toThrow();
  });

  it('groups revisions and template versions while separating accounts, environments, symbols, and sessions', () => {
    const original = proposalFixture();
    expect(opportunityKey({ ...original, template: { ...original.template, version: 2 } })).toBe(original.opportunityKey);
    expect(opportunityKey({ ...original, scope: { ...original.scope, accountId: 'replacement-account' } })).not.toBe(original.opportunityKey);
    expect(opportunityKey({ ...original, scope: { ...original.scope, environment: 'live' } })).not.toBe(original.opportunityKey);
    expect(opportunityKey({ ...original, symbol: 'OTHER' })).not.toBe(original.opportunityKey);
    expect(opportunityKey({ ...original, session: { ...original.session, tradingDate: '2026-09-21' } })).not.toBe(original.opportunityKey);
  });

  it('uses supplied early-close and DST session instants, not a hard-coded UTC close', () => {
    const p = proposalFixture();
    p.session.tradingDate = '2026-11-27';
    p.session.openAt = '2026-11-27T14:30:00.000Z';
    p.session.closeAt = '2026-11-27T18:00:00.000Z';
    p.session.calendarAsOf = '2026-11-27T12:00:00.000Z';
    p.generatedAt = '2026-11-27T14:55:00.000Z';
    p.validUntil = '2026-11-27T15:10:00.000Z';
    p.entryWindow = { from: '2026-11-27T15:00:00.000Z', to: '2026-11-27T17:45:00.000Z' };
    p.intendedEnd = '2026-11-27T17:55:00.000Z';
    p.opportunityKey = opportunityKey(p);
    // Old data is structurally representable; current-data freshness is a later admission gate.
    expect(() => validateProposal(p, templates)).not.toThrow();
  });
});

describe('honest forecasts', () => {
  it('round-trips unavailable as null numerical fields with a reason', () => {
    const proposal = proposalFixture();
    const parsed = JSON.parse(canonicalSerialize(proposal));
    expect(parsed.forecast).toEqual({ status: 'unavailable', reason: 'No estimator implemented',
      meanPnlCents: null, medianPnlCents: null, quantiles: null, probabilityOfProfit: null });
    expect(() => validateProposal(parsed, templates)).not.toThrow();
    for (const field of ['meanPnlCents', 'medianPnlCents', 'quantiles', 'probabilityOfProfit']) {
      expect(() => validateProposal(corrupted(`forecast.${field}`, 0), templates)).toThrow('unavailable_requires_null');
    }
    expect(() => validateProposal(corrupted('forecast.reason', ''), templates)).toThrow('expected_nonempty_text');
  });

  it('allows negative synthetic estimates and unknown unsupported statistics without computing a forecast', () => {
    const proposal = { ...proposalFixture(), forecast: numericForecastFixture() };
    expect(() => validateProposal(proposal, templates)).not.toThrow();
    expect(proposal.forecast.meanPnlCents).toBe(-100);
    expect(proposal.forecast.probabilityOfProfit).toBeNull();
  });

  it.each([
    { probabilityOfProfit: 1.01 }, { meanPnlCents: Infinity }, { meanPnlCents: 0.5 }, { sampleCount: 0 },
    { capitalCents: 0 }, { equityCents: 1 }, { activationAt: '2026-09-18T13:30:00.000Z' },
    { horizonEnd: '2026-09-18T21:00:00.000Z' }, { validUntil: '2026-09-18T14:00:00.000Z' },
    { quantiles: [{ probability: 0.9, pnlCents: 5 }, { probability: 0.1, pnlCents: 4 }] },
    { quantiles: [{ probability: 0.1, pnlCents: 5 }, { probability: 0.9, pnlCents: 4 }] },
    { meanPnlCents: null, medianPnlCents: null, quantiles: null, probabilityOfProfit: null },
  ])('rejects invalid numeric forecast metadata %j', change => {
    expect(() => validateProposal({ ...proposalFixture(), forecast: { ...numericForecastFixture(), ...change } }, templates)).toThrow(DomainValidationError);
  });
});



describe('quantity precision', () => {
  it.each([NaN, Infinity, -Infinity, -1, 0, 1e-10, 0.30000000000000004, 10_000_000])('rejects unsupported broker quantity %s', value => {
    expect(() => validateQuantity(value)).toThrow(DomainValidationError);
  });
  it('retains supported dust and allows zero only when explicitly requested', () => {
    expect(() => validateQuantity(1e-9)).not.toThrow();
    expect(() => validateQuantity(0, true)).not.toThrow();
    expect(() => validateQuantity(12.123456789)).not.toThrow();
  });
  it.each([[10000, 3, 33.333333333], [1, 3, 0.003333333], [1, 1e9, 0], [12345, 1.25, 98.76], [1, 1e-7, 100000]])(
    'floors %s cents at %s dollars to %s shares', (cents, price, expected) => {
      const quantity = quantityWithinBudget(cents, price);
      expect(quantity).toBe(expected);
      expect(quantity * price).toBeLessThanOrEqual(cents / 100);
      validateQuantity(quantity, true);
    });
  it('rejects invalid price, budget, and unrepresentable quantities', () => {
    for (const value of [NaN, Infinity, -1, 0]) {
      expect(() => quantityWithinBudget(value, 1)).toThrow();
      expect(() => quantityWithinBudget(100, value)).toThrow();
    }
    expect(() => quantityWithinBudget(1.1, 1)).toThrow();
    expect(() => quantityWithinBudget(10000, 1e-12)).toThrow();
  });
});
