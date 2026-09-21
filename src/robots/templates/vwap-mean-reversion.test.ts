import { FULL_SESSION_CALENDAR } from '../../core/exchange-session';
import { describe, expect, it } from 'vitest';
import { opportunityKey } from '../validation';
import { inputFixture, INTERVAL, iso, NOW, observe, OPEN, own } from './test-fixtures';
import { trendFollowing } from './trend-following';
import { inspectSessionVwap, vwapMeanReversion as template, VWAP_DEFAULTS } from './vwap-mean-reversion';
import { wickCapture } from './wick-capture';

const fixture = () => inputFixture(template);
const statistics = (input = fixture()) => inspectSessionVwap(input.market.bars, input.approved.plan.session, input.market.dataCutoff);

describe('bounded session VWAP mean reversion', () => {
  it('computes a hand-calculated volume-weighted typical-bar mean with a distinct below-mean market entry', () => {
    const input = fixture(), result = statistics(input);
    expect(result.status).toBe('available');
    if (result.status !== 'available') throw new Error('Expected synthetic session statistics');
    expect(result.statistics.vwap).toBeCloseTo((100 + 100.2 + 99.8 + 100.2 + 99.8 + 99.3) / 6, 10);
    expect(result.statistics.sessionDollars).toBeCloseTo(5_993_000, 6);
    expect(template.evaluate(input)).toMatchObject({ intent: { kind: 'entry', side: 'buy', orderType: 'market' },
      decision: { reasonCode: 'mean_reversion_entry' }, state: { signal: { disposition: 'pending_submission' } } });
    const trend = inputFixture(trendFollowing); trend.market = structuredClone(input.market); trend.market.capabilities = [...trendFollowing.requiredCapabilities];
    expect(trendFollowing.evaluate(trend).intent).toBeNull();
    const wick = inputFixture(wickCapture); wick.market = structuredClone(input.market); wick.market.capabilities = [...wickCapture.requiredCapabilities];
    expect(wickCapture.evaluate(wick).intent).toMatchObject({ kind: 'entry', orderType: 'limit' });
    observe(input, NOW, 101); expect(template.evaluate(input).intent).toBeNull();
  });
  it('uses observed volume weights rather than an unweighted average', () => {
    const input = fixture(); input.market.bars[5].v = 50000;
    const result = statistics(input); expect(result.status).toBe('available');
    if (result.status === 'available') expect(result.statistics.vwap).toBeCloseTo((500 + 99.3 * 5) / 10, 10);
  });
  it('resets at the exchange session boundary and never mixes prior-day volume or consumed signals', () => {
    const old = fixture(), first = template.evaluate(old);
    const current = JSON.parse(JSON.stringify(old), (_key, value) => typeof value === 'string' && value.startsWith('2026-09-18')
      ? '2026-09-21' + value.slice(10) : value) as ReturnType<typeof fixture>;
    current.approved.plan.opportunityKey = opportunityKey(current.approved.plan);
    current.state = { ...first.state, signal: { ...first.state.signal!, disposition: 'acknowledged' } };
    const prior = old.market.bars.map(bar => ({ ...bar, c: 10000, h: 10001, l: 9999, o: 10000, v: 1e9 }));
    const expected = statistics(current); current.market.bars.unshift(...prior);
    expect(statistics(current)).toEqual(expected); expect(template.evaluate(current).decision.reasonCode).toBe('mean_reversion_entry');
  });
  it('does not read prices or volume from incomplete, future, or other-session bars', () => {
    const input = fixture(), expected = statistics(input);
    for (const at of [NOW, NOW + INTERVAL, OPEN - 86_400_000, OPEN + 86_400_000]) {
      const excluded = { t: iso(at) } as any;
      for (const key of ['o', 'h', 'l', 'c', 'v']) Object.defineProperty(excluded, key, { get() { throw new Error('Unavailable bar accessed'); } });
      input.market.bars.push(excluded);
    }
    expect(statistics(input)).toEqual(expected); expect(template.evaluate(input).intent?.kind).toBe('entry');
  });
  for (const volume of [0, -1, NaN, Infinity, undefined]) it(`rejects missing or invalid volume (${volume})`, () => {
    const input = fixture(); input.market.bars[2].v = volume as number;
    expect(template.evaluate(input)).toMatchObject({ intent: null, decision: { reasonCode: 'invalid_price_or_volume' } });
  });
  it('requires warmup and contiguous history from the actual open, including on shortened sessions', () => {
    const input = fixture(); input.market.bars.pop();
    expect(template.evaluate(input).decision.reasonCode).toBe('warmup_required');
    input.market.bars.shift(); expect(template.evaluate(input).decision.reasonCode).toBe('incomplete_session_history');
    const short = fixture(); short.approved.plan.session.closeAt = '2026-09-18T17:00:00.000Z';
    short.approved.plan.intendedEnd = '2026-09-18T16:55:00.000Z'; short.approved.plan.entryWindow.to = '2026-09-18T16:45:00.000Z';
    short.market.session = { ...short.approved.plan.session };
    expect(template.evaluate(short).intent?.kind).toBe('entry');
  });
  for (const mode of ['gap', 'duplicate', 'bad_price', 'stale']) it(`blocks ${mode} history without reconstructing it`, () => {
    const input = fixture();
    if (mode === 'gap') input.market.bars.splice(2, 1);
    if (mode === 'duplicate') input.market.bars.push({ ...input.market.bars[2] });
    if (mode === 'bad_price') input.market.bars[2].h = 1;
    if (mode === 'stale') observe(input, NOW + INTERVAL + 1, 99.3);
    expect(template.evaluate(input).intent).toBeNull(); expect(template.evaluate(input).decision.vetoes.length).toBeGreaterThan(0);
  });
  for (const mode of ['liquidity', 'trend', 'minimum_volatility', 'maximum_volatility', 'spread', 'maximum_deviation'])
    it(`keeps the ${mode} filter explicit`, () => {
      const input = fixture();
      if (mode === 'liquidity') input.market.bars.forEach(b => { b.v = 1; });
      if (mode === 'trend') input.approved.plan.parameters.maxTrendPct = 0.5;
      if (mode === 'minimum_volatility') input.market.bars.forEach(b => { b.o = b.c = 100; b.h = 100.1; b.l = 99.9; });
      if (mode === 'maximum_volatility') input.approved.plan.parameters.maxVolatilityPct = 0.25;
      if (mode === 'spread') input.market.quote!.bidUsd = 98;
      if (mode === 'maximum_deviation') observe(input, NOW, 90);
      const result = template.evaluate(input); expect(result.intent).toBeNull(); expect(result.decision.reasonCode).toBe('mean_reversion_filters');
      expect(result.decision.conditions.some(c => c.result !== 'pass')).toBe(true);
    });
  it('exits attributable quantity at the observed mean and does not use entry filters to veto an owned exit', () => {
    const input = fixture(); own(input, 0.75, 99.3); observe(input, NOW, 100);
    input.execution.entriesAllowed = false;
    expect(template.evaluate(input)).toMatchObject({ intent: { kind: 'exit', quantity: 0.75 }, decision: { reasonCode: 'mean_reversion_exit' } });
  });
  for (const mode of ['stop', 'time', 'session']) it(`preserves ${mode} exit with missing bar history and entries paused`, () => {
    const input = fixture(); own(input, 0.5, 99.3); input.market.bars = []; input.execution.entriesAllowed = false;
    if (mode === 'stop') observe(input, NOW, 95);
    if (mode === 'time') observe(input, NOW + VWAP_DEFAULTS.holdMinutes * 60_000, 99.3);
    if (mode === 'session') observe(input, Date.parse(input.approved.plan.intendedEnd), 99.3);
    expect(template.evaluate(input)).toMatchObject({ intent: { kind: 'exit', quantity: 0.5 },
      decision: { reasonCode: mode === 'stop' ? 'stop_loss' : mode === 'time' ? 'holding_deadline' : 'session_exit' } });
  });
  it('requires an actual holding clock and preserves the earliest fill across later partial fills', () => {
    const input = fixture(); own(input, 0.5, 99.3); input.owned.firstFillAt = null;
    expect(template.evaluate(input).decision.reasonCode).toBe('first_fill_time_unavailable');
    input.owned.firstFillAt = iso(NOW); input.state = template.evaluate(input).state;
    input.owned.firstFillAt = iso(NOW + 60_000); observe(input, NOW + VWAP_DEFAULTS.holdMinutes * 60_000, 99.3);
    expect(template.evaluate(input).decision.reasonCode).toBe('holding_deadline');
  });
  it('persists consumed-bar identity across serialization and blocks duplicate entry while allowing protective exit', () => {
    const input = fixture(), entry = template.evaluate(input); input.state = JSON.parse(JSON.stringify(entry.state));
    expect(template.evaluate(input).decision.reasonCode).toBe('submission_pending');
    input.state.signal!.disposition = 'acknowledged'; expect(template.evaluate(input).decision.reasonCode).toBe('signal_consumed');
    own(input, 0.5, 99.3); observe(input, NOW, 90); expect(template.evaluate(input).decision.reasonCode).toBe('stop_loss');
    const held = fixture(); observe(held, NOW, 101); held.state = template.evaluate(held).state;
    observe(held, NOW, 99.3); expect(template.evaluate(held).decision.reasonCode).toBe('signal_consumed');
  });
  
});

it('keeps VWAP available beyond 78 candles in a 24/5 trading day', () => {
  const input = fixture(), open = Date.parse('2026-09-18T00:00:00Z');
  const session = { ...input.approved.plan.session, calendarId: FULL_SESSION_CALENDAR, openAt: iso(open), closeAt: iso(open + 86_400_000) };
  const bars = Array.from({ length: 200 }, (_, index) => ({ ...input.market.bars[index % 6], t: iso(open + index * INTERVAL) }));
  const result = inspectSessionVwap(bars, session, iso(open + 200 * INTERVAL));
  expect(result).toMatchObject({ status: 'available', statistics: { count: 200 } });
});
