import type { Bar } from '../../core/types';
import { evaluateObservedStops, type PriceObservation } from './execution-policy';

export interface MomentumParameters {
  fastPeriod: number;
  slowPeriod: number;
  /** Percent units: 1 means 1%. */
  stopLossPct: number;
  trailingStopPct: number;
}

export interface MomentumMetrics {
  trades: number;
  returnPct: number;
  winRatePct: number;
  maxDrawdownPct: number;
  /** Null when there are no losing trades, rather than an infinite ratio. */
  profitFactor: number | null;
}

export interface MomentumSetup {
  id: string;
  label: string;
  parameters: MomentumParameters;
  /** Full-window simulation, including the held-out sessions. */
  metrics: MomentumMetrics;
  validationMetrics: MomentumMetrics;
  eligible: boolean;
}

export interface MomentumReport {
  symbol: string;
  generatedAt: string;
  start: string;
  end: string;
  barCount: number;
  sessionCount: number;
  setups: MomentumSetup[];
  warning: string;
}

export const MOMENTUM_BACKTEST_ASSUMPTIONS = 'Last 7 calendar days; completed 5-minute weekday bars, 09:30–16:00 New York. At least 4 sessions with 48 bars each. Candidates fit earlier sessions; the final 2 sessions are held out. Long only, one position, compounded full-notional returns, 2 bps slippage per side, zero commissions. Replay samples five-minute opening prices; completed-candle signals execute at the next observation. Stops and trailing peaks use only observed prices, never candle lows/highs; exits fill at the observed price with slippage, not the stop threshold. This sparse replay cannot reproduce five-second browser cycles or crossings between observations. Stops are browser-managed market exits, not broker-held protective orders. Fills are immediate in simulation; broker delays, rejected orders, disconnects and account limits are not replayed. Drawdown is measured at observations. Planned exit at 15:55 ET; terminal positions are liquidated at the final close. Shortened sessions are not calendar-adjusted. Simulated results are not a forecast.';

export interface SimulatedExecution extends PriceObservation {
  side: 'buy' | 'sell';
  reason: string;
}

export interface MomentumReplay {
  metrics: MomentumMetrics;
  /** Simulated fill prices include slippage. These are not broker fills. */
  executions: SimulatedExecution[];
}

const FIVE_MINUTES = 300_000;
const WEEK = 7 * 86_400_000;
const SLIPPAGE = 0.0002;
const MIN_SESSION_BARS = 48;
const newYork = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

interface PreparedBar extends Bar { time: number; session: string; minute: number; closeMinute: number; contiguous: boolean; }
interface Signal { action: 'buy' | 'sell' | 'hold'; reason: string; }
export interface MomentumIndicators { fast: number; slow: number; previousFast: number; previousSlow: number; vwap: number; count: number; }
type Indicators = MomentumIndicators;

function marketTime(time: number): { session: string; minute: number; weekday: boolean } {
  const parts = newYork.formatToParts(time);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)?.value ?? '';
  return {
    session: `${get('year')}-${get('month')}-${get('day')}`,
    minute: Number(get('hour')) * 60 + Number(get('minute')),
    weekday: get('weekday') !== 'Sat' && get('weekday') !== 'Sun',
  };
}

function validNow(now: number): number {
  if (!Number.isFinite(now) || !Number.isFinite(new Date(now).getTime())) throw new Error('An explicit valid observation time is required.');
  return now;
}

/** Normalize once, before candidate evaluation; timestamps are candle starts. */
function prepare(bars: Bar[], now: number, session?: { openAt: string; closeAt: string; tradingDate: string }): PreparedBar[] {
  const unique = new Map<number, PreparedBar>();
  for (const bar of bars) {
    const time = Date.parse(bar.t);
    if (!Number.isFinite(time) || time < now - WEEK || time + FIVE_MINUTES > now || time % FIVE_MINUTES !== 0) continue;
    if (![bar.o, bar.h, bar.l, bar.c, bar.v].every(Number.isFinite) || Math.min(bar.o, bar.h, bar.l, bar.c) <= 0 || bar.v < 0) continue;
    if (bar.l > Math.min(bar.o, bar.c) || bar.h < Math.max(bar.o, bar.c) || bar.l > bar.h) continue;
    const clock = marketTime(time);
    if (session ? time < Date.parse(session.openAt) || time >= Date.parse(session.closeAt) : !clock.weekday || clock.minute < 570 || clock.minute >= 960) continue;
    unique.set(time, { ...bar, time, session: session?.tradingDate ?? clock.session,
      minute: session ? (time - Date.parse(session.openAt)) / 60_000 : clock.minute,
      closeMinute: session ? (Date.parse(session.closeAt) - Date.parse(session.openAt)) / 60_000 : 960, contiguous: false });
  }
  const ordered = [...unique.values()].sort((a, b) => a.time - b.time);
  ordered.forEach((bar, index) => { bar.contiguous = index > 0 && bar.session === ordered[index - 1].session && bar.time - ordered[index - 1].time === FIVE_MINUTES; });
  return ordered;
}

function validParameters(parameters: MomentumParameters): boolean {
  return Number.isInteger(parameters.fastPeriod) && Number.isInteger(parameters.slowPeriod)
    && parameters.fastPeriod >= 2 && parameters.slowPeriod > parameters.fastPeriod && parameters.slowPeriod <= 60
    && Number.isFinite(parameters.stopLossPct) && parameters.stopLossPct > 0 && parameters.stopLossPct <= 5
    && Number.isFinite(parameters.trailingStopPct) && parameters.trailingStopPct > 0 && parameters.trailingStopPct <= 5;
}

function indicatorSeries(bars: PreparedBar[], parameters: MomentumParameters): Indicators[] {
  let fast = 0, slow = 0, count = 0, value = 0, volume = 0;
  let session = '';
  const fastWeight = 2 / (parameters.fastPeriod + 1), slowWeight = 2 / (parameters.slowPeriod + 1);
  return bars.map((bar, index) => {
    if (bar.session !== session) { value = 0; volume = 0; session = bar.session; }
    if (index === 0 || !bar.contiguous) { fast = bar.c; slow = bar.c; count = 0; }
    const previousFast = fast, previousSlow = slow;
    fast += fastWeight * (bar.c - fast);
    slow += slowWeight * (bar.c - slow);
    value += (bar.h + bar.l + bar.c) / 3 * bar.v;
    volume += bar.v;
    return { fast, slow, previousFast, previousSlow, count: ++count, vwap: volume > 0 ? value / volume : NaN };
  });
}

function trendSignal(bar: PreparedBar, indicators: Indicators, parameters: MomentumParameters, hasPosition: boolean): Signal {
  if (bar.minute >= bar.closeMinute - 10) return { action: hasPosition ? 'sell' : 'hold', reason: 'Flatten before the regular session closes' };
  if (indicators.count < parameters.slowPeriod + 2) return { action: 'hold', reason: 'Waiting for continuous completed 5-minute history' };
  if (hasPosition) {
    if (bar.c < indicators.fast || indicators.fast <= indicators.slow) return { action: 'sell', reason: `Completed candle lost the EMA ${parameters.fastPeriod}/${parameters.slowPeriod} trend` };
    return { action: 'hold', reason: 'Momentum trend intact' };
  }
  if (bar.minute >= bar.closeMinute - 15) return { action: 'hold', reason: 'Entry window has closed for this session' };
  if (indicators.fast > indicators.slow && indicators.fast > indicators.previousFast && indicators.slow > indicators.previousSlow
    && bar.c > indicators.fast && bar.c > indicators.vwap) return { action: 'buy', reason: `Rising EMA ${parameters.fastPeriod}/${parameters.slowPeriod} trend above session VWAP` };
  return { action: 'hold', reason: 'Waiting for rising momentum above session VWAP' };
}

function emptyMetrics(): MomentumMetrics { return { trades: 0, returnPct: 0, winRatePct: 0, maxDrawdownPct: 0, profitFactor: null }; }

/** Only completed candles inform signals; only cycle observations inform stops. */
function simulate(bars: PreparedBar[], parameters: MomentumParameters, observations?: readonly PriceObservation[], now?: number): MomentumReplay {
  const executions: SimulatedExecution[] = [];
  if (!bars.length || !validParameters(parameters)) return { metrics: emptyMetrics(), executions };
  const indicators = indicatorSeries(bars, parameters);
  const end = bars[bars.length - 1].time + FIVE_MINUTES;
  // Recorded cycles replace the sparse proxy entirely. Missing cycles must not
  // acquire synthetic prices or extremes from a candle that happened meanwhile.
  const samples = observations === undefined ? bars.map(bar => ({ time: bar.time, price: bar.o }))
    : [...new Map(observations.filter(observation => Number.isFinite(observation.time)
      && observation.time >= bars[0].time && observation.time <= (now ?? end)
      && Number.isFinite(observation.price) && observation.price > 0)
      .map(observation => [observation.time, observation])).values()].sort((a, b) => a.time - b.time);
  let cash = 1, quantity = 0, entryPrice = 0, peakPrice = 0, entryEquity = 0;
  let equityPeak = 1, drawdown = 0, trades = 0, wins = 0, grossProfit = 0, grossLoss = 0;
  let completedIndex = -1, lastSignalBar = -1, lastGap = -1, entryTime = 0;
  let lastObservation: PriceObservation | undefined;
  const mark = (equity: number) => { equityPeak = Math.max(equityPeak, equity); drawdown = Math.max(drawdown, (equityPeak - equity) / equityPeak); };
  const sell = (observation: PriceObservation, reason: string) => {
    const price = observation.price * (1 - SLIPPAGE);
    cash = quantity * price;
    executions.push({ time: observation.time, price, side: 'sell', reason });
    const profit = cash - entryEquity;
    if (profit > 0) { wins++; grossProfit += profit; } else { grossLoss -= profit; }
    trades++;
    quantity = 0; peakPrice = 0;
    mark(cash);
  };
  for (const observation of samples) {
    const clock = marketTime(observation.time);
    if (!clock.weekday || clock.minute < 570 || clock.minute >= 960) continue;
    lastObservation = observation;
    while (completedIndex + 1 < bars.length && bars[completedIndex + 1].time + FIVE_MINUTES <= observation.time) {
      completedIndex++;
      if (completedIndex > 0 && !bars[completedIndex].contiguous) lastGap = completedIndex;
    }
    // Like an eligible bot cycle, exits precede the once-per-candle signal. No
    // observation means no peak update, stop trigger, or market-order fill.
    if (quantity && clock.minute >= 955) {
      sell(observation, 'Flatten before the regular session closes'); continue;
    }
    const stop = evaluateObservedStops(parameters, { hasPosition: quantity > 0, entryPrice, peakPrice }, observation);
    peakPrice = stop.peakPrice;
    if (stop.action === 'sell') { sell(observation, stop.reason); continue; }
    if (quantity) mark(quantity * observation.price * (1 - SLIPPAGE));
    const latest = bars[completedIndex];
    if (!latest || observation.time - latest.time > 2 * FIVE_MINUTES || latest.session !== clock.session) continue;
    if (lastSignalBar === completedIndex) continue;
    lastSignalBar = completedIndex;
    const gapSinceEntry = quantity > 0 && (marketTime(entryTime).session !== latest.session
      || lastGap >= 0 && bars[lastGap].time > entryTime);
    const signal = gapSinceEntry ? { action: 'sell', reason: 'Exit after a session or candle-data gap since entry' }
      : trendSignal(latest, indicators[completedIndex], parameters, quantity > 0);
    if (quantity && signal.action === 'sell') sell(observation, signal.reason);
    else if (!quantity && signal.action === 'buy' && clock.minute < 955) {
      entryPrice = observation.price * (1 + SLIPPAGE);
      entryEquity = cash;
      quantity = cash / entryPrice;
      peakPrice = entryPrice;
      entryTime = observation.time; cash = 0;
      executions.push({ time: observation.time, price: entryPrice, side: 'buy', reason: signal.reason });
      mark(quantity * observation.price * (1 - SLIPPAGE));
    }
  }
  // Terminal liquidation is an accounting assumption, not a stop observation.
  const terminal = observations === undefined ? { time: end, price: bars[bars.length - 1].c } : lastObservation;
  if (quantity && terminal) sell(terminal, 'End of replay liquidation');
  return {
    executions,
    metrics: {
      trades, returnPct: (cash - 1) * 100, winRatePct: trades ? wins / trades * 100 : 0,
      maxDrawdownPct: drawdown * 100, profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
    },
  };
}

/** Public deterministic simulator, also useful for inspecting a proposed preset. */
export function backtestMomentum(bars: Bar[], parameters: MomentumParameters, now: number): MomentumMetrics {
  return simulate(prepare(bars, validNow(now)), parameters).metrics;
}

/** Replay eligible browser-cycle snapshots; no prices are interpolated between them.
 * Signals use candles completed by each snapshot. Fills are immediate with fixed
 * slippage; any remaining position is liquidated at the last supplied observation.
 */
export function replayMomentum(
  bars: Bar[], parameters: MomentumParameters, observations: readonly PriceObservation[], now: number,
): MomentumReplay {
  now = validNow(now);
  return simulate(prepare(bars, now), parameters, observations, now);
}

function candidateParameters(training: PreparedBar[]): MomentumParameters[] {
  const ranges = training.map((bar, index) => {
    const previous = bar.contiguous && index > 0 ? training[index - 1].c : bar.o;
    return Math.max(bar.h - bar.l, Math.abs(bar.h - previous), Math.abs(bar.l - previous)) / bar.c * 100;
  }).sort((a, b) => a - b);
  const volatility = Math.max(0.02, ranges[Math.floor(ranges.length / 2)] ?? 0.05);
  const bounded = (value: number, max: number) => Math.round(Math.min(max, Math.max(0.12, value)) * 1000) / 1000;
  const candidates = new Map<string, MomentumParameters>();
  for (const fastPeriod of [4, 6, 9, 12]) for (const slowPeriod of [16, 24, 36]) {
    if (slowPeriod < fastPeriod * 1.5) continue;
    for (const risk of [1.5, 2.5, 4]) for (const trail of [1.5, 2.5]) {
      const parameters = { fastPeriod, slowPeriod, stopLossPct: bounded(volatility * risk, 2.5), trailingStopPct: bounded(volatility * trail, 3) };
      candidates.set(parameterId(parameters), parameters);
    }
  }
  return [...candidates.values()];
}

function parameterId(parameters: MomentumParameters): string {
  return `${parameters.fastPeriod}-${parameters.slowPeriod}-${parameters.stopLossPct}-${parameters.trailingStopPct}`;
}

export interface MomentumSearchStep {
  phase: 'training' | 'validation' | 'full_window';
  parameters: MomentumParameters;
  testedCandidates: number;
}
export interface MomentumSearchResult {
  report: MomentumReport;
  trainingSessions: string[];
  validationSessions: string[];
  tested: { parameters: MomentumParameters; trainingMetrics: MomentumMetrics }[];
}

/** Same legacy search, paused BEFORE each simulation so a scheduler can yield/cancel.
 * Draining synchronously retains the existing public tuner behavior and ordering.
 */
export function* searchMomentum(symbol: string, input: Bar[], now: number): Generator<MomentumSearchStep, MomentumSearchResult> {
  now = validNow(now);
  const prepared = prepare(input, now);
  const counts = new Map<string, number>();
  prepared.forEach(bar => counts.set(bar.session, (counts.get(bar.session) ?? 0) + 1));
  const sessions = [...counts].filter(([, count]) => count >= MIN_SESSION_BARS).map(([date]) => date);
  const qualifying = new Set(sessions);
  const bars = prepared.filter(bar => qualifying.has(bar.session));
  const report: MomentumReport = {
    symbol: symbol.trim().toUpperCase() || 'SPY', generatedAt: new Date(now).toISOString(),
    start: new Date(bars[0]?.time ?? now - WEEK).toISOString(),
    end: new Date(bars.length ? bars[bars.length - 1].time + FIVE_MINUTES : now).toISOString(),
    barCount: bars.length, sessionCount: sessions.length, setups: [], warning: MOMENTUM_BACKTEST_ASSUMPTIONS,
  };
  if (sessions.length < 4) {
    report.warning = `Insufficient history: found ${sessions.length} qualifying sessions; need at least 4 with 48 completed bars each. ${report.warning}`;
    return { report, trainingSessions: [], validationSessions: [], tested: [] };
  }
  const validationStart = sessions[sessions.length - 2];
  const training = bars.filter(bar => bar.session < validationStart);
  const validation = bars.filter(bar => bar.session >= validationStart);
  const score = (metrics: MomentumMetrics) => metrics.returnPct - 1.5 * metrics.maxDrawdownPct + Math.min(metrics.trades, 20) * 0.01;
  const tested: MomentumSearchResult['tested'] = [];
  for (const parameters of candidateParameters(training)) {
    yield { phase: 'training', parameters: { ...parameters }, testedCandidates: tested.length };
    tested.push({ parameters, trainingMetrics: simulate(training, parameters).metrics });
  }
  const ranked = [...tested].sort((a, b) => {
      const aPassed = a.trainingMetrics.trades >= 3 && a.trainingMetrics.returnPct > 0;
      const bPassed = b.trainingMetrics.trades >= 3 && b.trainingMetrics.returnPct > 0;
      return Number(bPassed) - Number(aPassed) || score(b.trainingMetrics) - score(a.trainingMetrics)
        || a.parameters.fastPeriod - b.parameters.fastPeriod || a.parameters.slowPeriod - b.parameters.slowPeriod;
    });
  // Present different signal speeds instead of three almost identical risk stops.
  const seen = new Set<string>();
  for (const candidate of ranked) {
    const { parameters, trainingMetrics } = candidate;
    const pair = `${parameters.fastPeriod}-${parameters.slowPeriod}`;
    if (seen.has(pair)) continue;
    seen.add(pair);
    yield { phase: 'validation', parameters: { ...parameters }, testedCandidates: tested.length };
    const validationMetrics = simulate(validation, parameters).metrics;
    yield { phase: 'full_window', parameters: { ...parameters }, testedCandidates: tested.length };
    report.setups.push({
      id: `${report.symbol}-${parameterId(parameters)}`,
      label: `EMA ${parameters.fastPeriod} / ${parameters.slowPeriod}`,
      parameters, metrics: simulate(bars, parameters).metrics, validationMetrics,
      eligible: trainingMetrics.trades >= 3 && trainingMetrics.returnPct > 0 && validationMetrics.trades >= 2 && validationMetrics.returnPct > 0,
    });
    if (report.setups.length === 3) break;
  }
  if (!report.setups.some(setup => setup.eligible)) report.warning = `No setup passed: require positive net results with at least 3 training trades and 2 held-out trades. ${report.warning}`;
  return { report, trainingSessions: sessions.slice(0, -2), validationSessions: sessions.slice(-2), tested };
}

/** Select on training only; held-out performance can disqualify, never re-rank. */
export function tuneMomentum(symbol: string, input: Bar[], now: number): MomentumReport {
  const search = searchMomentum(symbol, input, now);
  let step = search.next();
  while (!step.done) step = search.next();
  return step.value.report;
}

export function evaluateMomentum(
  bars: Bar[], parameters: MomentumParameters,
  state: { hasPosition: boolean; entryTime?: string }, now: number,
): Signal {
  return inspectMomentum(bars, parameters, state, validNow(now)).signal;
}

/** Pure diagnostics over the exact normalized candles used by the legacy signal.
 * Callers supply a valid cutoff; no ambient clock or unfinished-candle fallback.
 */
export function inspectMomentum(
  bars: Bar[], parameters: MomentumParameters,
  state: { hasPosition: boolean; entryTime?: string }, now: number,
  session?: { openAt: string; closeAt: string; tradingDate: string },
): { signal: Signal; latest: Bar | null; indicators: MomentumIndicators | null } {
  const unavailable = (reason: string) => ({ signal: { action: 'hold' as const, reason }, latest: null, indicators: null });
  if (!Number.isFinite(now) || !Number.isFinite(new Date(now).getTime())) return unavailable('Waiting for a valid data cutoff');
  if (!validParameters(parameters)) return unavailable('Momentum parameters are invalid');
  const completed = prepare(bars, now, session);
  const latest = completed[completed.length - 1];
  if (!latest || now - latest.time > 2 * FIVE_MINUTES) return unavailable('Waiting for fresh completed 5-minute candles');
  const currentSession = marketTime(now);
  if (session ? now < Date.parse(session.openAt) || now >= Date.parse(session.closeAt) : !currentSession.weekday || latest.session !== currentSession.session || currentSession.minute < 570 || currentSession.minute >= 960) return unavailable('Waiting for the regular trading session');
  const indicators = indicatorSeries(completed, parameters).at(-1)!;
  if (state.hasPosition) {
    const entryTime = Date.parse(state.entryTime ?? '');
    if (Number.isFinite(entryTime) && ((session ? entryTime < Date.parse(session.openAt) : marketTime(entryTime).session !== latest.session)
      || completed.some((bar, index) => index > 0 && bar.time > entryTime && !bar.contiguous))) {
      return { signal: { action: 'sell', reason: 'Exit after a session or candle-data gap since entry' }, latest, indicators };
    }
  }
  return { signal: trendSignal(latest, indicators, parameters, state.hasPosition), latest, indicators };
}
