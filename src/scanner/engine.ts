import type { HistoricalScannerSession, QuoteMetrics, ScannerBar, ScannerConfig, ScannerEvaluation, ScannerEvaluationInput, ScannerFeatures, ScannerQuote, ScannerSession, ScoreComponents, VolumeProfile } from './types';
export type * from './types';

export const MINUTE_MS = 60_000;
export const DEFAULT_SCANNER_CONFIG: ScannerConfig = {
  version: 1, enabled: true, statusChannelEnabled: false, baseUniverseSize: 500, quoteShortlistSize: 75, maxResults: 15,
  discoveryIntervalSeconds: 120, barGraceSeconds: 5, snapshotLimit: 120,
  baselineTargetSessions: 20, baselineMinSessions: 10, admissionMinutes: 2, removalMinutes: 3,
  replacementMinutes: 2, replacementScoreMargin: 3,
  minPrice: 10, minAverageDailyRthDollarVolume: 50_000_000, minDollarVolume5m: 1_000_000,
  minSessionRVOL: 1.5, minRecentRVOL10: 1.2, minEfficiency30: 0.35, minR2_30: 0.65,
  minVwapHold30: 0.8, maxJumpShare: 0.5, minReturn30: 0.003, minimumMoveToSpreadMultiple: 4,
  maxMedianSpreadBps: 10, maxCurrentSpreadBps: 10, maxQuoteAgeSeconds: 5,
  // RVOL anchors are ratios; scoring applies log to both the value and these anchors.
  anchors: { efficiency: [0.2, 0.7], r2: [0.4, 0.9], sessionRVOL: [1, 4], recentRVOL: [1, 3], vwapHold: [0.5, 1], spreadBps: [1, 10] },
};

export function validateScannerConfig(input: Partial<ScannerConfig> = {}): ScannerConfig {
  const config: ScannerConfig = { ...DEFAULT_SCANNER_CONFIG, ...input, anchors: { ...DEFAULT_SCANNER_CONFIG.anchors, ...input.anchors } };
  for (const [name, value] of Object.entries(config)) {
    if (name === 'anchors' || name === 'enabled' || name === 'statusChannelEnabled') continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new RangeError(`Invalid scanner configuration: ${name}`);
  }
  if (typeof config.enabled !== 'boolean') throw new RangeError('Invalid scanner configuration: enabled');
  if (typeof config.statusChannelEnabled !== 'boolean') throw new RangeError('Invalid scanner configuration: statusChannelEnabled');
  const integers: (keyof ScannerConfig)[] = ['version', 'baseUniverseSize', 'quoteShortlistSize', 'maxResults', 'snapshotLimit', 'baselineTargetSessions', 'baselineMinSessions', 'admissionMinutes', 'removalMinutes', 'replacementMinutes'];
  for (const key of integers) if (!Number.isInteger(config[key]) || Number(config[key]) < 1) throw new RangeError(`Invalid scanner configuration: ${key}`);
  if (config.baseUniverseSize > 2000 || config.quoteShortlistSize > 500 || config.maxResults > 100 || config.maxResults > config.quoteShortlistSize || config.snapshotLimit > 2000 || config.baselineTargetSessions > 60 || config.baselineMinSessions < 10 || config.baselineMinSessions > config.baselineTargetSessions || config.discoveryIntervalSeconds < 30 || config.barGraceSeconds >= 60 || config.maxQuoteAgeSeconds <= 0 || config.maxQuoteAgeSeconds > 60) throw new RangeError('Scanner resource/session settings are outside supported bounds');
  for (const key of ['minEfficiency30', 'minR2_30', 'minVwapHold30', 'maxJumpShare'] as const) if (config[key] > 1) throw new RangeError(`Invalid scanner ratio: ${key}`);
  for (const [name, anchors] of Object.entries(config.anchors)) {
    if (!Array.isArray(anchors) || anchors.length !== 2 || !anchors.every(Number.isFinite) || anchors[0] >= anchors[1] || ((name === 'sessionRVOL' || name === 'recentRVOL') && anchors[0] <= 0)) throw new RangeError(`Invalid scanner score anchors: ${name}`);
  }
  return config;
}

const finitePositive = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;
export function validScannerBar(bar: ScannerBar): boolean {
  return [bar.o, bar.h, bar.l, bar.c].every(finitePositive) && Number.isFinite(bar.v) && bar.v >= 0 && bar.h >= Math.max(bar.o, bar.c) && bar.l <= Math.min(bar.o, bar.c) && bar.h >= bar.l;
}

/** Last supplied revision wins. REST/live precedence is resolved in the data adapter. */
export function completedSessionBars(bars: ScannerBar[], session: ScannerSession, evaluationTime: number): ScannerBar[] {
  const result = new Map<number, ScannerBar>();
  for (const bar of bars) {
    const time = Date.parse(bar.t);
    if (Number.isFinite(time) && time >= session.open && time < session.close && (time - session.open) % MINUTE_MS === 0 && time + MINUTE_MS <= evaluationTime) result.set(time, bar);
  }
  return [...result].sort(([a], [b]) => a - b).map(([, bar]) => bar);
}

export function buildVolumeProfile(today: ScannerSession, history: HistoricalScannerSession[], config = DEFAULT_SCANNER_CONFIG): VolumeProfile {
  const minutes = (today.close - today.open) / MINUTE_MS;
  const byDate = new Map<string, HistoricalScannerSession>();
  for (const item of history) if (item.session.date < today.date && item.session.close <= today.open && item.session.close - item.session.open === minutes * MINUTE_MS) byDate.set(item.session.date, item);
  const candidates = [...byDate.values()].sort((a, b) => b.session.open - a.session.open).slice(0, config.baselineTargetSessions);
  const profiles: { date: string; volumes: number[]; dailyDollars: number }[] = [];
  for (const item of candidates) {
    if (!item.complete || item.session.mode !== today.mode) continue;
    const bars = completedSessionBars(item.bars, item.session, item.session.close);
    if ((!today.mode && bars.length !== minutes) || bars.some(bar => !validScannerBar(bar) || !finitePositive(bar.vw))) continue;
    const regular = item.regularSession ?? item.session;
    const regularBars = item.regularBars ? completedSessionBars(item.regularBars, regular, regular.close) : bars;
    if (today.mode && (!item.regularSession || regularBars.length !== 390 || regularBars.some((bar, index) =>
      Date.parse(bar.t) !== regular.open + index * MINUTE_MS || !validScannerBar(bar) || !finitePositive(bar.vw)))) continue;
    // Alpaca omits minutes without qualifying trades. Complete extended-session
    // responses contribute zero *reported bar volume* in those slots, not candles.
    const volumes = Array<number>(minutes).fill(0);
    for (const bar of bars) volumes[(Date.parse(bar.t) - item.session.open) / MINUTE_MS] = bar.v;
    profiles.push({ date: item.session.date, volumes, dailyDollars: regularBars.reduce((dollars, bar) => dollars + bar.v * bar.vw!, 0) });
  }
  const sampleCount = profiles.length;
  const meanMinuteVolume = Array.from({ length: minutes }, (_, index) => sampleCount ? profiles.reduce((sum, item) => sum + item.volumes[index], 0) / sampleCount : 0);
  let cumulative = 0;
  const meanCumulativeVolume = meanMinuteVolume.map(volume => cumulative += volume);
  const averageDailyRthDollarVolume = sampleCount ? profiles.reduce((sum, item) => sum + item.dailyDollars, 0) / sampleCount : null;
  const valid = sampleCount >= config.baselineMinSessions && finitePositive(averageDailyRthDollarVolume) && finitePositive(cumulative);
  return { valid, sampleCount, sessionDates: profiles.map(item => item.date), meanMinuteVolume, meanCumulativeVolume, averageDailyRthDollarVolume, reasons: valid ? [] : [sampleCount < config.baselineMinSessions ? `Only ${sampleCount} valid complete matching baseline sessions; ${config.baselineMinSessions} required` : 'Historical reported volume or regular-session liquidity is unavailable'] };
}

export interface WindowFeatures { slope: number; r2: number; efficiency: number; return: number; jumpShare: number | null }
/** Uses actual prices and elapsed minutes. Sparse windows need >=2/3 coverage,
 * at most two consecutive omitted bars, and the latest completed minute. */
export function calculateWindow(bars: ScannerBar[], minutes: number, evaluationTime = Date.parse(bars.at(-1)?.t ?? '') + MINUTE_MS, sparse = false): WindowFeatures | null {
  if (!Number.isInteger(minutes) || minutes < 1 || !Number.isFinite(evaluationTime)) return null;
  const start = evaluationTime - minutes * MINUTE_MS;
  const window = bars.filter(bar => Date.parse(bar.t) >= start && Date.parse(bar.t) + MINUTE_MS <= evaluationTime);
  if (window.length < (sparse ? Math.ceil(minutes * 2 / 3) : minutes) || window.length > minutes) return null;
  if (Date.parse(window[0].t) - start > (sparse ? 2 : 0) * MINUTE_MS || Date.parse(window.at(-1)!.t) + MINUTE_MS !== evaluationTime) return null;
  if (window.some((bar, index) => !validScannerBar(bar) || (Date.parse(bar.t) - start) % MINUTE_MS !== 0 || (index > 0 && (Date.parse(bar.t) <= Date.parse(window[index - 1].t) || Date.parse(bar.t) - Date.parse(window[index - 1].t) > (sparse ? 3 : 1) * MINUTE_MS)))) return null;
  const prices = [window[0].o, ...window.map(bar => bar.c)];
  if (!prices.every(finitePositive)) return null;
  const logs = prices.map(Math.log);
  const times = [(Date.parse(window[0].t) - start) / MINUTE_MS, ...window.map(bar => (Date.parse(bar.t) + MINUTE_MS - start) / MINUTE_MS)];
  const xMean = times.reduce((sum, value) => sum + value, 0) / times.length;
  const yMean = logs.reduce((sum, value) => sum + value, 0) / logs.length;
  let xx = 0, yy = 0, xy = 0, travel = 0, positiveTotal = 0, maxPositive = 0;
  for (let i = 0; i < prices.length; i++) {
    const x = times[i] - xMean, y = logs[i] - yMean;
    xx += x * x; yy += y * y; xy += x * y;
    if (i > 0) {
      travel += Math.abs(prices[i] - prices[i - 1]);
      const positive = Math.max(0, logs[i] - logs[i - 1]);
      positiveTotal += positive; maxPositive = Math.max(maxPositive, positive);
    }
  }
  const result: WindowFeatures = { slope: yy > 1e-24 ? xy / xx : 0, r2: yy > 1e-24 ? Math.min(1, Math.max(0, xy * xy / (xx * yy))) : 0, efficiency: travel > 0 ? Math.abs(prices.at(-1)! - prices[0]) / travel : 0, return: prices.at(-1)! / prices[0] - 1, jumpShare: positiveTotal > 0 ? maxPositive / positiveTotal : null };
  return Object.values(result).every(value => value === null || Number.isFinite(value)) ? result : null;
}

/** EMA9 starts at the SMA of the first nine observed session closes; no prior-session seed. */
export function calculateEMA(bars: ScannerBar[], period = 9): number | null {
  if (!Number.isInteger(period) || bars.length < period || period < 1 || bars.some(bar => !validScannerBar(bar))) return null;
  let ema = bars.slice(0, period).reduce((sum, bar) => sum + bar.c, 0) / period;
  const alpha = 2 / (period + 1);
  for (const bar of bars.slice(period)) ema += alpha * (bar.c - ema);
  return Number.isFinite(ema) ? ema : null;
}

/** Wilder ATR14 seeds with 14 true ranges; the first is high-low (no prior close). */
export function calculateATR(bars: ScannerBar[], period = 14): number | null {
  if (!Number.isInteger(period) || bars.length < period || period < 1 || bars.some(bar => !validScannerBar(bar))) return null;
  const ranges = bars.map((bar, index) => index === 0 ? bar.h - bar.l : Math.max(bar.h - bar.l, Math.abs(bar.h - bars[index - 1].c), Math.abs(bar.l - bars[index - 1].c)));
  let atr = ranges.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  for (const range of ranges.slice(period)) atr = (atr * (period - 1) + range) / period;
  return Number.isFinite(atr) ? atr : null;
}

export function normalized(value: number, low: number, high: number): number { return Math.max(0, Math.min(1, (value - low) / (high - low))); }
export function scoreScanner(features: ScannerFeatures, config = DEFAULT_SCANNER_CONFIG): { score: number; components: ScoreComponents } | null {
  const { efficiency30, r2_30, sessionRVOL, recentRVOL10, vwapHold30, medianSpreadBps } = features;
  if ([efficiency30, r2_30, sessionRVOL, recentRVOL10, vwapHold30, medianSpreadBps].some(value => value === null || !Number.isFinite(value)) || !finitePositive(sessionRVOL) || !finitePositive(recentRVOL10)) return null;
  const a = config.anchors;
  const components: ScoreComponents = {
    efficiency: 25 * normalized(efficiency30!, ...a.efficiency), r2: 20 * normalized(r2_30!, ...a.r2),
    sessionRVOL: 20 * normalized(Math.log(sessionRVOL), Math.log(a.sessionRVOL[0]), Math.log(a.sessionRVOL[1])),
    recentRVOL: 15 * normalized(Math.log(recentRVOL10), Math.log(a.recentRVOL[0]), Math.log(a.recentRVOL[1])),
    vwapHold: 10 * normalized(vwapHold30!, ...a.vwapHold), spread: 10 * (1 - normalized(medianSpreadBps!, ...a.spreadBps)),
  };
  return { components, score: Object.values(components).reduce((sum, value) => sum + value, 0) };
}

function quoteSpread(quote: ScannerQuote | null, now: number, maxAge: number): { spread: number | null; age: number | null; reason: string | null } {
  if (!quote) return { spread: null, age: null, reason: 'No quote available' };
  const time = Date.parse(quote.t), age = (now - time) / 1000;
  if (!Number.isFinite(time) || age < 0 || age > maxAge) return { spread: null, age: Number.isFinite(age) ? age : null, reason: 'Stale or invalid quote timestamp' };
  if (![quote.bp, quote.ap, quote.bs, quote.as].every(finitePositive) || quote.ap <= quote.bp) return { spread: null, age, reason: 'Invalid, locked, or crossed quote' };
  // Divide before scaling and average halves to avoid overflow for finite inputs.
  return { spread: (quote.ap - quote.bp) / (quote.ap / 2 + quote.bp / 2) * 10_000, age, reason: null };
}

/** Caller samples once per second. Missed seconds stay missing, never backfilled. */
export class QuoteSampler {
  private latest: ScannerQuote | null = null;
  private samples: { second: number; spread: number }[] = [];
  private lastSampleSecond = -Infinity;
  constructor(private readonly maxAgeSeconds = DEFAULT_SCANNER_CONFIG.maxQuoteAgeSeconds) {}
  ingest(quote: ScannerQuote): void {
    const time = Date.parse(quote.t), previous = this.latest ? Date.parse(this.latest.t) : -Infinity;
    if (Number.isFinite(time) && Number.isFinite(previous) && time < previous) return;
    this.latest = { ...quote };
  }
  sample(now: number): void {
    const second = Math.floor(now / 1000);
    this.samples = this.samples.filter(sample => sample.second > second - 60);
    if (second <= this.lastSampleSecond) return;
    this.lastSampleSecond = second;
    const quote = quoteSpread(this.latest, now, this.maxAgeSeconds);
    if (quote.spread !== null) this.samples.push({ second, spread: quote.spread });
  }
  metrics(now: number): QuoteMetrics {
    const quote = quoteSpread(this.latest, now, this.maxAgeSeconds);
    const second = Math.floor(now / 1000);
    const spreads = this.samples.filter(sample => sample.second > second - 60 && sample.second <= second).map(sample => sample.spread).sort((a, b) => a - b);
    const middle = Math.floor(spreads.length / 2);
    const medianSpreadBps = spreads.length ? spreads.length % 2 ? spreads[middle] : (spreads[middle - 1] + spreads[middle]) / 2 : null;
    const reasons = quote.reason ? [quote.reason] : [];
    if (spreads.length < 45) reasons.push(`Warming quotes: ${spreads.length}/45 valid one-second samples`);
    return { valid: quote.spread !== null && spreads.length >= 45, currentSpreadBps: quote.spread, medianSpreadBps, quoteAgeSeconds: quote.age, validSamples: spreads.length, reasons };
  }
  reset(): void { this.latest = null; this.samples = []; this.lastSampleSecond = -Infinity; }
}

export function evaluateScanner(input: ScannerEvaluationInput): ScannerEvaluation {
  const config = input.config ?? DEFAULT_SCANNER_CONFIG;
  const { session, evaluationTime, profile, quote } = input;
  const expected = Math.max(0, Math.min(Math.floor((evaluationTime - session.open) / MINUTE_MS), Math.floor((session.close - session.open) / MINUTE_MS)));
  const bars = completedSessionBars(input.bars, session, evaluationTime);
  const last = bars.at(-1);
  const f: ScannerFeatures = {
    price: last?.c ?? null, priceTimestamp: last ? new Date(Date.parse(last.t) + MINUTE_MS).toISOString() : null,
    dailyChange: last && finitePositive(input.priorClose) ? last.c / input.priorClose - 1 : null,
    sessionRVOL: null, recentRVOL10: null, dollarVolume5m: null, averageDailyRthDollarVolume: profile?.averageDailyRthDollarVolume ?? null,
    efficiency30: null, slope30: null, r2_30: null, slope10: null, r2_10: null, slope60: null, r2_60: null,
    return30: null, return10: null, return60: null, sessionVWAP: null, vwapHold30: null, vwapDistance: null, jumpShare: null,
    currentSpreadBps: quote?.currentSpreadBps ?? null, medianSpreadBps: quote?.medianSpreadBps ?? null,
    quoteAgeSeconds: quote?.quoteAgeSeconds ?? null, quoteSamples: quote?.validSamples ?? 0, baselineSampleCount: profile?.sampleCount ?? 0,
    ema9: null, atr14: null, extended: false, confirmed60: false, sparkline: bars.slice(-60).map(bar => bar.c),
  };
  const evaluation: ScannerEvaluation = { symbol: input.symbol, sessionDate: session.date, evaluationTime, minute: Math.floor((session.open + expected * MINUTE_MS) / MINUTE_MS), configVersion: config.version, qualified: false, hardFailure: false, dataStatus: 'ready', reasons: [], features: f, score: null, components: null, flags: [] };
  const unavailable = (reason: string, status: ScannerEvaluation['dataStatus'] = 'unavailable', hard = true): ScannerEvaluation => { evaluation.dataStatus = status; evaluation.hardFailure = hard; evaluation.reasons.push(reason); evaluation.flags = [status === 'forming' ? 'Forming' : status === 'loading-history' ? 'Loading history' : status === 'warming-quotes' ? 'Warming quotes' : status === 'closed' ? 'Not live' : 'Data unavailable']; return evaluation; };
  if (!input.eligible) return unavailable('Asset is not eligible');
  if (input.halted) return unavailable('Known trading halt');
  if (!Number.isFinite(evaluationTime) || !Number.isFinite(session.open) || !Number.isFinite(session.close) || session.close <= session.open) return unavailable('Invalid session or evaluation timestamp');
  if (evaluationTime < session.open || evaluationTime >= session.close) return unavailable('Outside the trading session', 'closed');
  const times = new Set(bars.map(bar => Date.parse(bar.t)));
  const coveredThrough = session.mode && Number.isFinite(input.barsCoveredThrough) ? Math.min(evaluationTime, input.barsCoveredThrough!) : session.open;
  const unknownGap = Array.from({ length: expected }, (_, index) => session.open + index * MINUTE_MS).some(time => !times.has(time) && !(time < coveredThrough));
  if (unknownGap || bars.some(bar => !validScannerBar(bar))) return unavailable('Missing, stale, or invalid session minute bars');
  if (expected > 0 && (!last || Date.parse(last.t) + MINUTE_MS !== evaluationTime)) return unavailable('No trade bar for the latest completed minute');
  if (bars.some(bar => !finitePositive(bar.vw))) return unavailable('Missing or invalid bar VWAP; dollar volume and session VWAP are unavailable');
  let volume = 0, dollars = 0;
  const vwaps = bars.map(bar => { volume += bar.v; dollars += bar.v * bar.vw!; return volume > 0 ? dollars / volume : null; });
  f.sessionVWAP = vwaps.at(-1) ?? null;
  f.vwapDistance = last && finitePositive(f.sessionVWAP) ? last.c / f.sessionVWAP - 1 : null;
  f.ema9 = calculateEMA(bars); f.atr14 = calculateATR(bars);
  f.extended = !!last && f.ema9 !== null && f.atr14 !== null && last.c > f.ema9 + 2 * f.atr14;
  const since = (minutes: number) => bars.filter(bar => Date.parse(bar.t) >= evaluationTime - minutes * MINUTE_MS);
  f.dollarVolume5m = expected >= 5 ? since(5).reduce((sum, bar) => sum + bar.v * bar.vw!, 0) : null;
  const window = (minutes: number) => expected >= minutes ? calculateWindow(bars, minutes, evaluationTime, !!session.mode) : null;
  const w10 = window(10), w30 = window(30), w60 = window(60);
  if (w10) { f.slope10 = w10.slope; f.r2_10 = w10.r2; f.return10 = w10.return; }
  if (w30) {
    f.slope30 = w30.slope; f.r2_30 = w30.r2; f.return30 = w30.return; f.efficiency30 = w30.efficiency; f.jumpShare = w30.jumpShare;
    const recent = since(30), contemporaneous = vwaps.slice(-recent.length);
    if (contemporaneous.every(finitePositive)) f.vwapHold30 = recent.filter((bar, index) => bar.c > contemporaneous[index]!).length / recent.length;
  }
  if (w60) { f.slope60 = w60.slope; f.r2_60 = w60.r2; f.return60 = w60.return; f.confirmed60 = w60.slope > 0 && w60.return > 0; }
  if (expected < 30) return unavailable('Thirty completed session minutes are required', 'forming', false);
  if (!w10 || !w30) return unavailable('Insufficient observed bars in the recent trend windows');
  if (!profile?.valid || profile.sampleCount < config.baselineMinSessions || profile.meanMinuteVolume.length !== (session.close - session.open) / MINUTE_MS || profile.meanCumulativeVolume.length !== (session.close - session.open) / MINUTE_MS) return unavailable(profile?.reasons.join('; ') || 'Historical volume profile is loading', 'loading-history');
  const baselineCumulative = profile.meanCumulativeVolume[expected - 1];
  const baselineRecent = profile.meanMinuteVolume.slice(expected - 10, expected).reduce((sum, value) => sum + value, 0);
  if (!finitePositive(baselineCumulative) || !finitePositive(baselineRecent)) return unavailable('Historical volume denominator is unavailable');
  f.sessionRVOL = volume / baselineCumulative;
  f.recentRVOL10 = since(10).reduce((sum, bar) => sum + bar.v, 0) / baselineRecent;
  if (!quote?.valid) {
    const warming = !quote || (quote.currentSpreadBps !== null && quote.validSamples < 45);
    return unavailable(quote?.reasons.join('; ') || 'Quotes are warming up', warming ? 'warming-quotes' : 'unavailable');
  }
  const required = [f.price, f.sessionRVOL, f.recentRVOL10, f.averageDailyRthDollarVolume, f.dollarVolume5m, f.efficiency30, f.r2_30, f.slope30, f.slope10, f.return10, f.return30, f.sessionVWAP, f.vwapHold30, f.jumpShare, f.currentSpreadBps, f.medianSpreadBps, f.quoteAgeSeconds];
  if (required.some(value => value === null || !Number.isFinite(value))) return unavailable('A required feature is undefined or non-finite');
  if (f.quoteAgeSeconds! < 0 || f.quoteAgeSeconds! > config.maxQuoteAgeSeconds || f.currentSpreadBps! <= 0 || f.medianSpreadBps! <= 0 || f.quoteSamples < 45) return unavailable('Quote freshness, validity, or sample coverage failed');
  const gates: [boolean, string][] = [
    [f.price! >= config.minPrice, 'Price below minimum'],
    [f.averageDailyRthDollarVolume! >= config.minAverageDailyRthDollarVolume, 'Average daily RTH dollar volume below minimum'],
    [f.dollarVolume5m! >= config.minDollarVolume5m, 'Five-minute dollar volume below minimum'],
    [f.sessionRVOL! >= config.minSessionRVOL, 'Session RVOL below minimum'], [f.recentRVOL10! >= config.minRecentRVOL10, 'Recent RVOL below minimum'],
    [f.slope30! > 0, 'Thirty-minute slope is not positive'], [f.slope10! > 0 && f.return10! > 0, 'Recent ten-minute trend is not upward'],
    [f.efficiency30! >= config.minEfficiency30, 'Thirty-minute efficiency below minimum'], [f.r2_30! >= config.minR2_30, 'Thirty-minute R² below minimum'],
    [f.price! > f.sessionVWAP!, 'Latest close is not above session VWAP'], [f.vwapHold30! >= config.minVwapHold30, 'VWAP hold below minimum'],
    [f.jumpShare! <= config.maxJumpShare, 'Single-jump concentration above maximum'],
    [f.currentSpreadBps! <= config.maxCurrentSpreadBps && f.medianSpreadBps! <= config.maxMedianSpreadBps, 'Quoted spread above maximum'],
    [f.return30! >= Math.max(config.minReturn30, config.minimumMoveToSpreadMultiple * f.medianSpreadBps! / 10_000), 'Thirty-minute return below required move/spread threshold'],
  ];
  evaluation.reasons = gates.filter(([pass]) => !pass).map(([, reason]) => reason);
  const score = scoreScanner(f, config);
  if (score) { evaluation.score = score.score; evaluation.components = score.components; }
  else evaluation.reasons.push('Required ranking inputs are invalid');
  evaluation.qualified = evaluation.reasons.length === 0 && score !== null;
  evaluation.flags = [...(evaluation.qualified ? ['Clean uptrend'] : []), ...(f.confirmed60 ? ['60m confirmed'] : []), ...(f.extended ? ['Extended'] : [])];
  return evaluation;
}

/** Numeric ties retain prior order; new names fall back to a locale-independent symbol order. */
export function rankEvaluations(evaluations: ScannerEvaluation[], previousOrder: string[] = []): ScannerEvaluation[] {
  const order = new Map(previousOrder.map((symbol, index) => [symbol, index]));
  return evaluations.filter(row => row.qualified && row.score !== null && Number.isFinite(row.score)).sort((a, b) => b.score! - a.score! || (order.get(a.symbol) ?? Infinity) - (order.get(b.symbol) ?? Infinity) || (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0));
}

export function explainScanner(evaluation: ScannerEvaluation): string {
  const f = evaluation.features;
  if (!evaluation.qualified) return evaluation.reasons.join('; ');
  return `Volume is ${f.sessionRVOL!.toFixed(1)}× normal for this time; recent volume is ${f.recentRVOL10!.toFixed(1)}× normal. The last 30 minutes show a consistent upward trend, with ${Math.round(f.vwapHold30! * 100)}% of closes above session VWAP. Median spread is ${f.medianSpreadBps!.toFixed(1)} basis points.`;
}
