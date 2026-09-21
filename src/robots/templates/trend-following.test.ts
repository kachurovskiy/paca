import { describe, expect, it } from 'vitest';
import { evaluateMomentum, inspectMomentum, replayMomentum, tuneMomentum } from '../math/momentum';
import { evaluateObservedStops } from '../math/execution-policy';
import { initialTemplateState } from './common';
import { bars, inputFixture, INTERVAL, iso, NOW, observe, OPEN, own, trendParameters } from './test-fixtures';
import { trendFollowing } from './trend-following';

describe('Trend Following characterization', () => {
  it.each([0, 1, 4, 5, 6, 8, 30])('matches existing warmup and signal decisions for %i bars', count => {
    const input = inputFixture(); input.market.bars = bars(count);
    // Retain a valid approved clock, using partial history ending at this cutoff.
    if (count > 6) observe(input, OPEN + count * INTERVAL, 100 + count);
    const legacy = evaluateMomentum(input.market.bars, trendParameters, { hasPosition: false }, Date.parse(input.evaluatedAt));
    const adapted = trendFollowing.evaluate(input);
    expect(adapted.intent && 'side' in adapted.intent ? adapted.intent.side : 'hold').toBe(legacy.action);
    if (count === 5) expect(adapted.decision.reasonCode).toBe('warmup_required');
    if (count === 6) expect(adapted.decision.reasonCode).toBe('trend_entry');
  });

  it('uses the same EMA/VWAP diagnostic values and leaves unavailable VWAP unavailable', () => {
    const input = inputFixture();
    const inspect = inspectMomentum(input.market.bars, trendParameters, { hasPosition: false }, NOW);
    const decision = trendFollowing.evaluate(input).decision;
    expect(decision.conditions.find(item => item.code === 'ema_fast_above_slow')).toMatchObject({ observed: inspect.indicators!.fast, threshold: inspect.indicators!.slow });
    expect(decision.conditions.find(item => item.code === 'close_above_vwap')).toMatchObject({ observed: inspect.latest!.c, threshold: inspect.indicators!.vwap });
    input.market.bars = input.market.bars.map(bar => ({ ...bar, v: 0 }));
    const unavailable = trendFollowing.evaluate(input);
    expect(unavailable.intent).toBeNull();
    expect(unavailable.decision.conditions.find(item => item.code === 'close_above_vwap')).toMatchObject({ result: 'unavailable', observed: null });
  });

  it('ignores unfinished/future/malformed bars and keys disposition to the actual normalized completed bar', () => {
    const input = inputFixture(), original = trendFollowing.evaluate(input);
    input.market.bars = [...input.market.bars, { ...bars()[0], t: iso(NOW), c: 1000, h: 1000 },
      { ...bars()[0], t: iso(NOW - 1), c: NaN }].reverse();
    expect(trendFollowing.evaluate(input)).toEqual(original);
    expect(original.state.signal?.inputRef).toBe(iso(NOW - INTERVAL));
    // The quote and history are separately timestamped; later completed bars cannot leak through the cutoff.
    input.market.dataCutoff = iso(NOW - 1); input.market.quote!.at = iso(NOW - 1);
    expect(trendFollowing.evaluate(input).decision.reasonCode).toBe('warmup_required');
  });

  it('requires new warmup after missing candles, and exits a gap after its own entry', () => {
    const input = inputFixture(); input.market.bars = bars(10).filter((_, index) => index !== 7);
    observe(input, OPEN + 10 * INTERVAL, 110);
    expect(trendFollowing.evaluate(input).decision.reasonCode).toBe('warmup_required');
    own(input, 2, 106);
    const legacy = evaluateMomentum(input.market.bars, trendParameters, { hasPosition: true, entryTime: iso(NOW) }, Date.parse(input.evaluatedAt));
    expect(legacy.reason).toContain('gap');
    expect(trendFollowing.evaluate(input)).toMatchObject({ intent: { side: 'sell' }, decision: { reasonCode: 'data_gap_exit' } });
  });

  it('consumes no-action and acknowledged bars and holds a candidate pending submission', () => {
    const input = inputFixture(), entry = trendFollowing.evaluate(input);
    input.state = entry.state;
    expect(trendFollowing.evaluate(input)).toMatchObject({ intent: null, decision: { reasonCode: 'submission_pending' } });
    input.state = { ...input.state, signal: { ...input.state.signal!, disposition: 'acknowledged' } };
    expect(trendFollowing.evaluate(input)).toMatchObject({ intent: null, decision: { reasonCode: 'signal_consumed' } });
    input.state = initialTemplateState(trendFollowing.identity); input.market.bars = bars(8, 0);
    input.state = trendFollowing.evaluate(input).state;
    input.market.bars = bars();
    expect(trendFollowing.evaluate(input).decision.reasonCode).toBe('signal_consumed');
  });

  

  

  it('uses one canonical signal identity for equivalent provider candle timestamps', () => {
    const input = inputFixture(); input.market.bars = input.market.bars.map(bar => ({ ...bar, t: bar.t.replace('.000Z', 'Z') }));
    const entry = trendFollowing.evaluate(input);
    expect(entry.state.signal?.inputRef).toBe(iso(NOW - INTERVAL));
    input.state = { ...entry.state, signal: { ...entry.state.signal!, disposition: 'acknowledged' } };
    input.market.bars = bars();
    expect(trendFollowing.evaluate(input).decision.reasonCode).toBe('signal_consumed');
  });

  it('does not compare an older quote against a newer observed peak', () => {
    const input = inputFixture(); own(input); observe(input, NOW + 5000, 110);
    input.state = trendFollowing.evaluate(input).state;
    input.market.quote = { ...input.market.quote!, at: iso(NOW), priceUsd: 100 };
    expect(trendFollowing.evaluate(input)).toMatchObject({ intent: null, decision: { reasonCode: 'stale_quote' } });
  });

  it('caps very large candidate quantities without overflowing the domain precision grid', () => {
    const input = inputFixture(); observe(input, NOW, Number.MIN_VALUE);
    expect(trendFollowing.evaluate(input).intent).toMatchObject({ kind: 'entry', quantity: 100_000 });
    input.market.quote!.askUsd = Number.MAX_VALUE;
    expect(trendFollowing.evaluate(input)).toMatchObject({ intent: null, decision: { reasonCode: 'capital_below_one_share' } });
  });

  it.each([[106, 103, 106], [106, 106.5, 95], [106, 120, 107], [106, 107, 95]].map(prices => ({ prices })))('matches observed-stop and replay decisions for $prices', ({ prices }) => {
    const input = inputFixture(), history = bars();
    history[6] = { ...history[6], h: 120, l: 95 }; input.market.bars = history;
    const observations = prices.map((price, index) => ({ time: NOW + index * 5000, price }));
    const replay = replayMomentum(history, trendParameters, observations, NOW + INTERVAL);
    const actual: { side: string; time: number; price: number }[] = [];
    let oldPeak = 0;
    for (const sample of observations) {
      observe(input, sample.time, sample.price);
      const legacyStop = evaluateObservedStops(trendParameters, { hasPosition: input.owned.quantity! > 0,
        entryPrice: input.owned.averageEntryPriceUsd ?? undefined, peakPrice: oldPeak }, sample);
      oldPeak = legacyStop.peakPrice;
      const evaluated = trendFollowing.evaluate(structuredClone(input)); input.state = evaluated.state;
      expect(evaluated.state.observedPeak?.priceUsd ?? 0).toBe(oldPeak);
      const intent = evaluated.intent;
      if (intent && intent.kind !== 'cancel') {
        const price = sample.price * (intent.side === 'buy' ? 1.0002 : 0.9998);
        actual.push({ side: intent.side, time: sample.time, price });
        if (intent.side === 'buy') own(input, intent.quantity, price, sample.time);
        else input.owned = { quantity: 0, positionKey: null, averageEntryPriceUsd: null, entryAt: null, firstFillAt: null };
        if (input.state.signal) input.state = { ...input.state, signal: { ...input.state.signal, disposition: 'acknowledged' } };
      }
    }
    expect(replay.executions.some(execution => execution.reason === 'End of replay liquidation')).toBe(false);
    expect(actual).toEqual(replay.executions.map(({ side, time, price }) => ({ side, time, price })));
  });

  it('resets the observed peak when reconciliation identifies a new round trip', () => {
    const input = inputFixture(); own(input, 1, 100);
    observe(input, NOW, 150); input.state = trendFollowing.evaluate(input).state;
    expect(input.state.observedPeak?.priceUsd).toBe(150);
    own(input, 1, 80, NOW, 'next-position'); observe(input, NOW + 5000, 80);
    const next = trendFollowing.evaluate(input);
    expect(next.state.observedPeak?.priceUsd).toBe(80); expect(next.decision.reasonCode).not.toBe('trailing_stop');
  });

  it('uses fresh observations for stops despite absent bars, and never substitutes an old close', () => {
    const input = inputFixture(); own(input); input.market.bars = [];
    observe(input, NOW + 5000, 95);
    expect(trendFollowing.evaluate(input).decision.reasonCode).toBe('stop_loss');
    observe(input, NOW + 5000, 108); input.market.bars = bars();
    expect(trendFollowing.evaluate(input).intent).toBeNull();
    input.owned.averageEntryPriceUsd = null;
    expect(trendFollowing.evaluate(input).decision.reasonCode).toBe('entry_cost_unavailable');
    observe(input, Date.parse(input.approved.plan.intendedEnd), 95);
    expect(trendFollowing.evaluate(input).decision.reasonCode).toBe('session_exit');
  });

  it('blocks early-close entries explicitly while allowing exits against supplied session bounds', () => {
    const input = inputFixture();
    input.approved.plan.session.closeAt = '2026-09-18T17:00:00.000Z';
    input.approved.plan.entryWindow.to = '2026-09-18T16:45:00.000Z'; input.approved.plan.intendedEnd = '2026-09-18T16:55:00.000Z';
    input.market.session = { ...input.approved.plan.session };
    expect(trendFollowing.evaluate(input).decision.reasonCode).toBe('unsupported_short_session');
    own(input); observe(input, Date.parse(input.approved.plan.intendedEnd));
    expect(trendFollowing.evaluate(input).decision.reasonCode).toBe('session_exit');
  });

  it('adapts existing research without changing tuning/ranking or granting validated evidence', () => {
    const input = inputFixture(), sessions = [14, 15, 16, 17, 18].map(day => ({ ...input.approved.plan.session,
      tradingDate: `2026-09-${day}`, openAt: `2026-09-${day}T13:30:00.000Z`, closeAt: `2026-09-${day}T20:00:00.000Z`, calendarAsOf: `2026-09-${day}T12:00:00.000Z` }));
    const history = sessions.flatMap(session => bars(78, 0.1).map((bar, index) => ({ ...bar, t: iso(Date.parse(session.openAt) + index * INTERVAL) })));
    const cutoff = sessions.at(-1)!.closeAt;
    const research = trendFollowing.research({ symbol: 'TEST', bars: history, dataCutoff: cutoff, sessions });
    expect(research.status).toBe('experimental');
    if (research.status !== 'experimental') throw new Error('Expected experimental research');
    expect(research.report).toEqual(tuneMomentum('TEST', history, Date.parse(cutoff)));
    expect(research.limitations.join(' ')).toContain('not a validated badge or forecast');
    sessions[0].closeAt = '2026-09-14T17:00:00.000Z';
    expect(trendFollowing.research({ symbol: 'TEST', bars: history, dataCutoff: cutoff, sessions }).status).toBe('unavailable');
    expect(trendFollowing.research({ symbol: 'TEST', bars: history, dataCutoff: cutoff, sessions: [] }).status).toBe('unavailable');
    expect(trendFollowing.research({ symbol: 'TEST', bars: history, dataCutoff: '1', sessions }).status).toBe('unavailable');
  });
});
