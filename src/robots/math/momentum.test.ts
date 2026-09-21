import { describe, expect, it } from 'vitest';
import { backtestMomentum, evaluateMomentum, replayMomentum, tuneMomentum, type MomentumParameters } from './momentum';
import type { Bar } from '../../core/types';

const interval = 300_000;
const now = Date.parse('2026-09-18T20:00:00Z');
const parameters: MomentumParameters = { fastPeriod: 2, slowPeriod: 4, stopLossPct: 2, trailingStopPct: 1 };

function session(day = 18, count = 78, step = 0.1, initial = 100): Bar[] {
  const start = Date.UTC(2026, 8, day, 13, 30);
  return Array.from({ length: count }, (_, index) => {
    const o = initial + index * step, c = o + step;
    return { t: new Date(start + index * interval).toISOString(), o, c, h: Math.max(o, c) + 0.01, l: Math.min(o, c) - 0.01, v: 1000 };
  });
}
function week(): Bar[] { return [14, 15, 16, 17, 18].flatMap(day => session(day)); }
function completedAt(bars: Bar[]): number { return Date.parse(bars[bars.length - 1].t) + interval; }

describe('automatic momentum calibration', () => {
  it('returns bounded, ticker-specific presets with separate held-out results', () => {
    const report = tuneMomentum(' spy ', week(), now);
    expect(report).toMatchObject({ symbol: 'SPY', barCount: 390, sessionCount: 5 });
    expect(report.setups).toHaveLength(3);
    expect(report.warning).toContain('2 bps slippage per side');
    expect(report.warning).toContain('final 2 sessions are held out');
    expect(report.setups.every(setup => setup.eligible)).toBe(true);
    for (const setup of report.setups) {
      expect(setup.metrics.trades).toBe(5);
      expect(setup.validationMetrics.trades).toBe(2);
      expect(setup.metrics.returnPct).toBeGreaterThan(setup.validationMetrics.returnPct);
      expect(setup.parameters.fastPeriod).toBeLessThan(setup.parameters.slowPeriod);
      expect(setup.parameters.stopLossPct).toBeGreaterThanOrEqual(0.12);
      expect(setup.parameters.stopLossPct).toBeLessThanOrEqual(2.5);
      expect(setup.parameters.trailingStopPct).toBeLessThanOrEqual(3);
      expect(setup.metrics.profitFactor).toBeNull();
    }
  });

  it('never uses validation prices to tune or rank candidate parameters', () => {
    const original = tuneMomentum('SPY', week(), now);
    const failedValidation = tuneMomentum('SPY', [...[14, 15, 16].flatMap(day => session(day)), ...[17, 18].flatMap(day => session(day, 78, 0))], now);
    expect(failedValidation.setups.map(setup => setup.parameters)).toEqual(original.setups.map(setup => setup.parameters));
    expect(failedValidation.setups.map(setup => setup.id)).toEqual(original.setups.map(setup => setup.id));
    expect(failedValidation.setups.every(setup => !setup.eligible)).toBe(true);
    expect(failedValidation.setups.every(setup => setup.validationMetrics.trades === 0)).toBe(true);
    expect(failedValidation.warning).toContain('No setup passed');
  });

  it('requires meaningful history and refuses to recommend untested trades', () => {
    const thin = tuneMomentum('QQQ', [16, 17, 18].flatMap(day => session(day)), now);
    expect(thin.setups).toEqual([]);
    expect(thin.warning).toContain('Insufficient history');
    const shortSessions = tuneMomentum('SPY', [14, 15, 16, 17, 18].flatMap(day => session(day, 20)), now);
    expect(shortSessions.sessionCount).toBe(0);
    expect(shortSessions.setups).toEqual([]);
    const insufficientTrades = tuneMomentum('SPY', [15, 16, 17, 18].flatMap(day => session(day)), now);
    expect(insufficientTrades.setups.every(setup => !setup.eligible)).toBe(true);
    expect(insufficientTrades.warning).toContain('3 training trades');
  });

  it('sorts/deduplicates inputs and excludes stale, malformed, extended-hours and future data', () => {
    const bars = week();
    const unexpected = [
      { ...bars[0], t: 'invalid' }, { ...bars[0], c: NaN }, { ...bars[0], l: bars[0].h + 1 },
      { ...bars[0], t: '2026-09-18T13:31:00Z' }, { ...bars[0], t: '2026-09-18T12:55:00Z' },
      { ...bars[0], t: '2026-09-13T13:30:00Z' }, { ...bars[0], t: '2026-09-10T13:30:00Z' },
      { ...bars[0], t: '2026-09-21T13:30:00Z' }, { ...bars[0], v: -1 },
    ];
    expect(tuneMomentum('SPY', [...bars, bars[0], ...unexpected].reverse(), now)).toEqual(tuneMomentum('SPY', bars, now));
    expect(tuneMomentum('', [], now).symbol).toBe('SPY');
  });

  it('calibrates risk to training volatility while retaining finite bounds', () => {
    const low = tuneMomentum('LOW', week(), now);
    const high = tuneMomentum('HIGH', week().map(bar => ({ ...bar, h: bar.h + 2, l: bar.l - 2 })), now);
    expect(high.setups[0].parameters.stopLossPct).toBeGreaterThan(low.setups[0].parameters.stopLossPct);
    expect(high.setups.every(setup => Object.values(setup.parameters).every(Number.isFinite))).toBe(true);
    expect(high.setups.every(setup => setup.parameters.stopLossPct <= 2.5 && setup.parameters.trailingStopPct <= 3)).toBe(true);
  });
});

describe('momentum execution simulation', () => {
  it('executes a completed signal at the next open, with entry and exit costs', () => {
    const bars = session(18, 8, 1);
    const metrics = backtestMomentum(bars, parameters, completedAt(bars));
    expect(metrics.trades).toBe(1);
    expect(metrics.returnPct).toBeCloseTo((108 * 0.9998 / (106 * 1.0002) - 1) * 100, 10);
    const gap = bars.map((bar, index) => index < 6 ? bar : { ...bar, o: 120, c: 120, h: 120, l: 120 });
    const gapped = backtestMomentum(gap, parameters, completedAt(gap));
    expect(gapped.returnPct).toBeCloseTo((0.9998 / 1.0002 - 1) * 100, 10);
  });

  it('does not enter from a stale signal after missing candles', () => {
    const bars = session(18, 8, 1).map((bar, index) => index < 6 ? bar : { ...bar, t: new Date(Date.parse(bar.t) + 2 * interval).toISOString() });
    expect(backtestMomentum(bars, parameters, completedAt(bars)).trades).toBe(0);
  });

  it('takes the next observable opening price after a data gap, including losses beyond stops', () => {
    const bars = session(18, 8, 1);
    bars.push({ t: new Date(completedAt(bars) + interval).toISOString(), o: 90, h: 91, l: 89, c: 90, v: 1000 });
    const metrics = backtestMomentum(bars, parameters, completedAt(bars));
    expect(metrics.trades).toBe(1);
    expect(metrics.returnPct).toBeCloseTo((90 * 0.9998 / (106 * 1.0002) - 1) * 100, 10);
    expect(metrics.maxDrawdownPct).toBeGreaterThan(15);
  });

  it('ignores unobserved candle lows for stops and highs for trailing peaks', () => {
    const bars = session(18, 8, 1);
    const ordinary = backtestMomentum(bars, parameters, completedAt(bars));
    bars[6] = { ...bars[6], h: 120, l: 95 };
    const metrics = backtestMomentum(bars, parameters, completedAt(bars));
    expect(metrics).toEqual(ordinary);
  });

  it('uses the opening price when a stop is gapped through', () => {
    const bars = session(18, 8, 1);
    bars[7] = { ...bars[7], o: 95, h: 96, l: 94, c: 95 };
    expect(backtestMomentum(bars, parameters, completedAt(bars)).returnPct)
      .toBeCloseTo((95 * 0.9998 / (106 * 1.0002) - 1) * 100, 10);
  });

  it('schedules liquidation at 15:55 and cannot profit from a final candle spike', () => {
    const bars = session();
    const ordinary = backtestMomentum(bars, parameters, now);
    bars[77] = { ...bars[77], h: 1000, c: 1000 };
    expect(backtestMomentum(bars, parameters, now)).toEqual(ordinary);
  });

  it('replays supplied cycles, filling an observed crossing at its price instead of the stop threshold', () => {
    const bars = session(18, 8, 1);
    bars[6] = { ...bars[6], l: 95, h: 120 };
    const entry = Date.parse(bars[6].t);
    const samples = [{ time: entry, price: 106 }, { time: entry + 5000, price: 95 }, { time: entry + 10000, price: 107 }];
    const replay = replayMomentum(bars, parameters, samples, completedAt(bars));
    expect(replay.executions).toEqual([
      expect.objectContaining({ time: entry, price: 106 * 1.0002, side: 'buy' }),
      expect.objectContaining({ time: entry + 5000, price: 95 * 0.9998, side: 'sell', reason: 'Stop loss reached (2%)' }),
    ]);
    expect(replay.metrics.returnPct).toBeCloseTo((95 * 0.9998 / (106 * 1.0002) - 1) * 100, 10);
    const missed = replayMomentum(bars, parameters, [samples[0], samples[2]], completedAt(bars));
    expect(missed.executions[1]).toMatchObject({ time: entry + 10000, reason: 'End of replay liquidation' });
    expect(missed.metrics.returnPct).toBeGreaterThan(0);
  });

  it('tightens trailing stops only when a supplied cycle observes the peak', () => {
    const bars = session(18, 8, 1);
    const entry = Date.parse(bars[6].t);
    const samples = [{ time: entry, price: 106 }, { time: entry + 5000, price: 110 }, { time: entry + 10000, price: 108 }];
    const seen = replayMomentum(bars, parameters, samples, completedAt(bars));
    expect(seen.executions[1]).toMatchObject({ time: entry + 10000, price: 108 * 0.9998, reason: 'Trailing stop reached (1%)' });
    const unseen = replayMomentum(bars, parameters, [samples[0], samples[2]], completedAt(bars));
    expect(unseen.executions[1].reason).toBe('End of replay liquidation');
  });

  it('does not invent observations for empty, invalid or out-of-window cycle history', () => {
    const bars = session(18, 8, 1);
    const end = completedAt(bars);
    const result = replayMomentum(bars, parameters, [
      { time: end + 5000, price: 90 }, { time: end - interval, price: NaN },
      { time: NaN, price: 90 }, { time: end - interval, price: 0 },
    ], end);
    expect(result).toEqual(replayMomentum(bars, parameters, [], end));
    expect(result.metrics.trades).toBe(0);
    expect(result.executions).toEqual([]);
  });

  it('keeps observing stops after the latest candle completes, even if candle history goes stale', () => {
    const bars = session(18, 6, 1);
    const entry = completedAt(bars);
    for (const delay of [5000, 20 * 60_000]) {
      const result = replayMomentum(bars, parameters, [
        { time: entry, price: 106 }, { time: entry + delay, price: 95 },
      ], entry + delay);
      expect(result.executions[1]).toMatchObject({ time: entry + delay, price: 95 * 0.9998, reason: 'Stop loss reached (2%)' });
    }
  });

  it('orders and deduplicates observations without changing the input or consulting unfinished candles', () => {
    const bars = session(18, 8, 1);
    const entry = Date.parse(bars[6].t);
    const samples = [{ time: entry, price: 106 }, { time: entry + 5000, price: 95 }];
    const expected = replayMomentum(bars, parameters, samples, completedAt(bars));
    const unordered = [samples[1], { time: entry, price: 500 }, samples[0]];
    const original = structuredClone(unordered);
    bars[6] = { ...bars[6], h: 1000, c: 1000 };
    expect(replayMomentum(bars, parameters, unordered, completedAt(bars))).toEqual(expected);
    expect(unordered).toEqual(original);
  });
});

describe('live momentum signals', () => {
  it('trades only completed fresh candles and ignores an unfinished spike', () => {
    const bars = session(18, 30, 0);
    const at = completedAt(bars);
    bars.push({ t: new Date(at).toISOString(), o: 100, h: 150, l: 100, c: 150, v: 1000 });
    expect(evaluateMomentum(bars, parameters, { hasPosition: false }, at).action).toBe('hold');
    const rising = session(18, 30);
    expect(evaluateMomentum(rising, parameters, { hasPosition: false }, completedAt(rising)).action).toBe('buy');
    expect(evaluateMomentum(rising, parameters, { hasPosition: false }, completedAt(rising) + 20 * 60_000).action).toBe('hold');
  });

  it('requires fresh continuous warmup following a session or missing-data gap', () => {
    const bars = [...session(17), ...session(18, 4)];
    expect(evaluateMomentum(bars, parameters, { hasPosition: false }, completedAt(bars)).action).toBe('hold');
    const rising = session(18, 30).filter((_, index) => index !== 27);
    expect(evaluateMomentum(rising, parameters, { hasPosition: false }, completedAt(rising)).action).toBe('hold');
  });

  it('exits gaps occurring after its own entry and ignores gaps before entry', () => {
    const bars = session(18, 30).filter((_, index) => index !== 25);
    const at = completedAt(bars);
    expect(evaluateMomentum(bars, parameters, { hasPosition: true, entryTime: '2026-09-18T15:00:00Z' }, at))
      .toMatchObject({ action: 'sell', reason: 'Exit after a session or candle-data gap since entry' });
    expect(evaluateMomentum(bars, parameters, { hasPosition: true, entryTime: '2026-09-18T15:45:00Z' }, at).action).toBe('hold');
    const resumedSession = session(18, 30);
    expect(evaluateMomentum(resumedSession, parameters, { hasPosition: true, entryTime: '2026-09-17T19:58:00Z' }, completedAt(resumedSession)))
      .toMatchObject({ action: 'sell', reason: 'Exit after a session or candle-data gap since entry' });
  });

  it('schedules the session exit without opening late positions', () => {
    const late = session(18, 77);
    expect(evaluateMomentum(late, parameters, { hasPosition: true }, completedAt(late))).toMatchObject({ action: 'sell', reason: 'Flatten before the regular session closes' });
    expect(evaluateMomentum(late, parameters, { hasPosition: false }, completedAt(late)).action).toBe('hold');
    expect(evaluateMomentum(session(), parameters, { hasPosition: false }, now).action).toBe('hold');
  });

  it('rejects invalid parameter sets', () => {
    const bars = session(18, 30);
    expect(evaluateMomentum(bars, { ...parameters, stopLossPct: NaN }, { hasPosition: false }, completedAt(bars)).action).toBe('hold');
    expect(evaluateMomentum(bars, { ...parameters, fastPeriod: 10 }, { hasPosition: false }, completedAt(bars)).action).toBe('hold');
  });
});
