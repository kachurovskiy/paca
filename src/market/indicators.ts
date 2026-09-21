import type { Bar } from '../core/types';

export interface TrendState {
  hasPosition: boolean;
  entryPrice?: number;
  stopLossPct: number;
  trailingStopPct: number;
  peakPrice?: number;
}

export interface TrendSignal {
  action: 'buy' | 'sell' | 'hold';
  reason: string;
  trend: 'bullish' | 'bearish' | 'neutral';
  /** Confidence-style trend strength from 0 to 100; this is not a probability. */
  strength: number;
}

function ema(values: number[], period: number): number[] {
  const weight = 2 / (period + 1);
  return values.reduce<number[]>((result, value, index) => {
    result.push(index === 0 ? value : value * weight + result[index - 1] * (1 - weight));
    return result;
  }, []);
}

function relativeStrengthIndex(values: number[], period = 14): number {
  if (values.length <= period) return Number.NaN;
  let gain = 0;
  let loss = 0;
  for (let index = 1; index <= period; index++) {
    const change = values[index] - values[index - 1];
    gain += Math.max(0, change) / period;
    loss += Math.max(0, -change) / period;
  }
  for (let index = period + 1; index < values.length; index++) {
    const change = values[index] - values[index - 1];
    gain = (gain * (period - 1) + Math.max(0, change)) / period;
    loss = (loss * (period - 1) + Math.max(0, -change)) / period;
  }
  if (gain === 0 && loss === 0) return 50;
  return loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
}

/** Indicator values align one-to-one with the supplied candles. */
export function computeIndicators(bars: Bar[]): { ema9: number[]; ema21: number[]; vwap: number[]; rsi: number } {
  const closes = bars.map(bar => bar.c);
  let cumulativeValue = 0;
  let cumulativeVolume = 0;
  let session = '';
  const vwap = bars.map(bar => {
    const date = new Date(bar.t).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    if (date !== session) {
      cumulativeValue = 0;
      cumulativeVolume = 0;
      session = date;
    }
    const volume = Math.max(0, bar.v);
    cumulativeValue += ((bar.h + bar.l + bar.c) / 3) * volume;
    cumulativeVolume += volume;
    return cumulativeVolume > 0 ? cumulativeValue / cumulativeVolume : Number.NaN;
  });
  return { ema9: ema(closes, 9), ema21: ema(closes, 21), vwap, rsi: relativeStrengthIndex(closes) };
}

/**
 * Candle timestamps denote candle start, as in Alpaca responses. The median
 * interval excludes an unfinished candle. Percent thresholds use percent units
 * (1 means 1%). The caller remains responsible for position sizing/execution.
 */
export function evaluateTrend(bars: Bar[], state: TrendState, now: number): TrendSignal {
  const hold = (reason: string): TrendSignal => ({ action: 'hold', reason, trend: 'neutral', strength: 0 });
  if (bars.length < 26) return hold('Waiting for at least 26 completed candles');
  if (bars.some(bar => !Number.isFinite(bar.c) || bar.c <= 0 || !Number.isFinite(Date.parse(bar.t)))) {
    return hold('Candle data is incomplete');
  }
  const intervals = bars.slice(1).map((bar, index) => Date.parse(bar.t) - Date.parse(bars[index].t)).filter(interval => interval > 0).sort((a, b) => a - b);
  if (!intervals.length) return hold('Candle timestamps are invalid');
  const duration = intervals[Math.floor(intervals.length / 2)];
  const completed = bars.filter(bar => Date.parse(bar.t) + duration <= now);
  if (completed.length < 26) return hold('Waiting for at least 26 completed candles');
  const indicators = computeIndicators(completed);
  const index = completed.length - 1;
  const price = completed[index].c;
  const fast = indicators.ema9[index];
  const slow = indicators.ema21[index];
  const rising = fast > indicators.ema9[index - 2] && slow > indicators.ema21[index - 2];
  const bullish = fast > slow && rising && price > indicators.vwap[index];
  const bearish = fast < slow && price < indicators.vwap[index];
  const trend: TrendSignal['trend'] = bullish ? 'bullish' : bearish ? 'bearish' : 'neutral';
  const spread = Math.abs(fast - slow) / price;
  const strength = Math.min(100, Math.round(spread * 10000 + (bullish || bearish ? 35 : 0)));
  const result = (action: TrendSignal['action'], reason: string): TrendSignal => ({ action, reason, trend, strength });

  if (state.hasPosition) {
    if (state.entryPrice && state.stopLossPct > 0 && price <= state.entryPrice * (1 - state.stopLossPct / 100)) {
      return result('sell', `Stop loss reached (${state.stopLossPct}%)`);
    }
    if (state.peakPrice && state.trailingStopPct > 0 && price <= state.peakPrice * (1 - state.trailingStopPct / 100)) {
      return result('sell', `Trailing stop reached (${state.trailingStopPct}%)`);
    }
    if (price < fast) return result('sell', 'Completed candle closed below EMA 9');
    if (fast <= slow) return result('sell', 'EMA 9 lost the EMA 21 uptrend');
    return result('hold', 'Trend intact; holding position');
  }
  if (bullish && price > fast) return result('buy', 'EMA 9 above rising EMA 21; price above VWAP');
  return result('hold', 'Waiting for a rising EMA trend above VWAP');
}
