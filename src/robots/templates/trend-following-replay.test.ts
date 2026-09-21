import { describe, expect, it } from 'vitest';
import { trendFollowing } from './trend-following';
import { inputFixture, observe, own } from './test-fixtures';
import type { PriceObservation } from '../math/execution-policy';
import { replayMomentum, type MomentumParameters } from '../math/momentum';
import type { Bar } from '../../core/types';

const start = Date.parse('2026-09-18T13:30:00Z');
const interval = 300_000;
const entryTime = start + 6 * interval;
const iso = (time: number) => new Date(time).toISOString();
const parameters: MomentumParameters = { fastPeriod: 2, slowPeriod: 4, stopLossPct: 2, trailingStopPct: 1 };

function history(): Bar[] {
  return Array.from({ length: 8 }, (_, index) => {
    const o = 100 + index;
    return { t: iso(start + index * interval), o, h: o + 1.01, l: o - 0.01, c: o + 1, v: 1000 };
  });
}

/** Immediate fills isolate strategy decisions from broker delay and rejection. */
async function executeCycles(bars: Bar[], observations: PriceObservation[]) {
  const input = inputFixture();
  input.market.bars = bars;
  const executions: { side: 'buy' | 'sell'; time: number; price: number }[] = [];
  for (const observation of observations) {
    observe(input, observation.time, observation.price);
    const result = trendFollowing.evaluate(input);
    input.state = structuredClone(result.state);
    if (!result.intent || result.intent.kind === 'cancel') continue;
    const { side, quantity } = result.intent;
    const price = observation.price * (side === 'buy' ? 1.0002 : 0.9998);
    if (side === 'buy') { expect(input.owned.quantity).toBe(0); own(input, quantity, price, observation.time, String(executions.length)); }
    else { expect(quantity).toBe(input.owned.quantity); input.owned = { quantity: 0, positionKey: null, averageEntryPriceUsd: null, entryAt: null, firstFillAt: null }; }
    if (input.state.signal) input.state.signal.disposition = 'acknowledged';
    executions.push({ side, price, time: observation.time });
  }
  return { executions, inventory: input.owned.quantity };
}

async function expectParity(bars: Bar[], observations: PriceObservation[]) {
  const replay = replayMomentum(bars, parameters, observations, start + bars.length * interval);
  const live = await executeCycles(bars, observations);
  // Every scenario naturally exits, so terminal accounting cannot manufacture parity.
  expect(live.inventory).toBe(0);
  expect(replay.executions.some(execution => execution.reason === 'End of replay liquidation')).toBe(false);
  expect(live.executions).toEqual(replay.executions.map(({ side, time, price }) => ({ side, time, price })));
  return replay.executions;
}

describe('momentum replay and pure template execution parity', () => {
  it('exits an observed brief dip at the observed price and cannot reenter on recovery in the same candle', async () => {
    const bars = history();
    bars[6] = { ...bars[6], l: 103, h: 108 };
    const executions = await expectParity(bars, [
      { time: entryTime, price: 106 },
      { time: entryTime + 5_000, price: 103 },
      { time: entryTime + 10_000, price: 106 },
      { time: entryTime + 15_000, price: 107 },
    ]);
    expect(executions.map(({ side, time }) => ({ side, time }))).toEqual([
      { side: 'buy', time: entryTime }, { side: 'sell', time: entryTime + 5_000 },
    ]);
    expect(executions[1].price).toBe(103 * 0.9998);
    expect(executions[1].reason).toContain('Stop loss');
  });

  it('ignores a candle low missed by both observers until a later observed crossing', async () => {
    const bars = history();
    bars[6] = { ...bars[6], l: 95, h: 108 };
    const executions = await expectParity(bars, [
      { time: entryTime, price: 106 },
      { time: entryTime + 5_000, price: 106.5 },
      { time: entryTime + 10_000, price: 107 },
      { time: entryTime + 15_000, price: 95 },
    ]);
    expect(executions).toHaveLength(2);
    expect(executions[1].time).toBe(entryTime + 15_000);
    expect(executions[1].price).toBe(95 * 0.9998);
  });

  it.each([false, true])('trails an intrabar spike only when the cycle observed it: %s', async observedSpike => {
    const bars = history();
    bars[6] = { ...bars[6], h: 120, l: 95 };
    const executions = await expectParity(bars, [
      { time: entryTime, price: 106 },
      { time: entryTime + 5_000, price: observedSpike ? 120 : 106.5 },
      { time: entryTime + 10_000, price: 107 },
      { time: entryTime + 15_000, price: 95 },
    ]);
    expect(executions).toHaveLength(2);
    expect(executions[1].time).toBe(entryTime + (observedSpike ? 10_000 : 15_000));
    expect(executions[1].reason).toContain(observedSpike ? 'Trailing stop' : 'Stop loss');
  });

  it('resets the peak for a later entry and consumes each completed-candle signal only once', async () => {
    const bars = history();
    bars[6] = { ...bars[6], h: 120, l: 106 };
    bars[7] = { ...bars[7], h: 108, l: 105 };
    const executions = await expectParity(bars, [
      { time: entryTime, price: 106 },
      { time: entryTime + 5_000, price: 120 },
      { time: entryTime + 10_000, price: 107 },
      { time: entryTime + 15_000, price: 107 },
      { time: entryTime + interval, price: 107 },
      { time: entryTime + interval + 5_000, price: 107.1 },
      { time: entryTime + interval + 10_000, price: 105 },
      { time: entryTime + interval + 15_000, price: 107 },
    ]);
    expect(executions.map(({ side, time }) => ({ side, time }))).toEqual([
      { side: 'buy', time: entryTime },
      { side: 'sell', time: entryTime + 10_000 },
      { side: 'buy', time: entryTime + interval },
      { side: 'sell', time: entryTime + interval + 10_000 },
    ]);
  });
});
