import { describe, expect, it } from 'vitest';
import { evaluateObservedStops, MOMENTUM_EXECUTION_POLICY, type PriceObservation } from './execution-policy';

const parameters = { stopLossPct: 2, trailingStopPct: 1 };
const time = Date.parse('2026-09-18T14:00:00Z');

function replay(prices: number[]) {
  let peakPrice = 100;
  return prices.map((price, index) => {
    const decision = evaluateObservedStops(parameters, { hasPosition: true, entryPrice: 100, peakPrice }, {
      time: time + index * MOMENTUM_EXECUTION_POLICY.cycleIntervalMs, price,
    });
    peakPrice = decision.peakPrice;
    return decision;
  });
}

describe('observed-price execution policy', () => {
  it('only triggers a brief crossing when a cycle actually observes it', () => {
    expect(replay([100, 100.1]).map(decision => decision.action)).toEqual(['hold', 'hold']);
    expect(replay([100, 97, 100.1])[1]).toMatchObject({ action: 'sell', reason: 'Stop loss reached (2%)' });
  });

  it('only tightens the trailing stop from an observed high', () => {
    expect(replay([100, 100.5]).at(-1)).toMatchObject({ peakPrice: 100.5, action: 'hold' });
    expect(replay([100, 105, 100.5]).at(-1)).toMatchObject({ peakPrice: 105, action: 'sell', reason: 'Trailing stop reached (1%)' });
  });

  it('produces a market exit intent after an observed gap without promising a stop-level fill', () => {
    const observation: PriceObservation = { time, price: 90 };
    expect(evaluateObservedStops(parameters, { hasPosition: true, entryPrice: 100, peakPrice: 105 }, observation))
      .toEqual({ peakPrice: 105, action: 'sell', reason: 'Stop loss reached (2%)' });
    expect(MOMENTUM_EXECUTION_POLICY).toMatchObject({ stopMode: 'observed-price', orderType: 'market' });
    expect(observation.price).toBe(90);
  });

  it('anchors the first peak to the actual entry cost and includes exact threshold crossings', () => {
    expect(evaluateObservedStops(parameters, { hasPosition: true, entryPrice: 100 }, { time, price: 99 }))
      .toMatchObject({ peakPrice: 100, action: 'sell', reason: 'Trailing stop reached (1%)' });
    expect(evaluateObservedStops(parameters, { hasPosition: true, entryPrice: 100 }, { time, price: 98 }))
      .toMatchObject({ peakPrice: 100, action: 'sell', reason: 'Stop loss reached (2%)' });
  });

  it('clears a previous position peak while flat so a new position starts from its own observations', () => {
    const flat = evaluateObservedStops(parameters, { hasPosition: false, entryPrice: 100, peakPrice: 150 }, { time, price: 80 });
    expect(flat).toMatchObject({ peakPrice: 0, action: 'hold' });
    expect(evaluateObservedStops(parameters, { hasPosition: true, entryPrice: 80, peakPrice: flat.peakPrice }, { time, price: 80 }))
      .toMatchObject({ peakPrice: 80, action: 'hold' });
  });

  it.each([
    { time, price: NaN }, { time, price: Infinity }, { time, price: 0 }, { time, price: -1 },
    { time: NaN, price: 200 }, { time: Infinity, price: 200 }, { time: Number.MAX_VALUE, price: 200 },
  ])('ignores invalid observations without poisoning or raising the peak: %j', observation => {
    expect(evaluateObservedStops(parameters, { hasPosition: true, entryPrice: 100, peakPrice: 105 }, observation))
      .toMatchObject({ peakPrice: 105, action: 'hold' });
  });

  it.each([undefined, NaN, Infinity, 0, -1])('holds while the entry cost basis is invalid: %s', entryPrice => {
    expect(evaluateObservedStops(parameters, { hasPosition: true, entryPrice, peakPrice: 105 }, { time, price: 90 }))
      .toMatchObject({ peakPrice: 105, action: 'hold', reason: 'Waiting for broker fill cost basis' });
  });

  it.each([NaN, Infinity, 0, -1])('recovers from an invalid stored peak: %s', peakPrice => {
    expect(evaluateObservedStops(parameters, { hasPosition: true, entryPrice: 100, peakPrice }, { time, price: 101 }))
      .toMatchObject({ peakPrice: 101, action: 'hold' });
  });

  it.each([
    { stopLossPct: NaN, trailingStopPct: 1 }, { stopLossPct: 0, trailingStopPct: 1 },
    { stopLossPct: 2, trailingStopPct: -1 }, { stopLossPct: 2, trailingStopPct: Infinity },
  ])('holds for invalid stop percentages: %j', invalidParameters => {
    expect(evaluateObservedStops(invalidParameters, { hasPosition: true, entryPrice: 100, peakPrice: 105 }, { time, price: 90 }))
      .toMatchObject({ peakPrice: 105, action: 'hold', reason: 'Stop parameters are invalid' });
  });
});
