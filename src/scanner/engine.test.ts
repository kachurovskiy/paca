import { describe, expect, it } from 'vitest';
import { buildVolumeProfile, calculateATR, calculateEMA, calculateWindow, completedSessionBars, DEFAULT_SCANNER_CONFIG, evaluateScanner, QuoteSampler, rankEvaluations, scoreScanner, validateScannerConfig } from './engine';
import type { HistoricalScannerSession, QuoteMetrics, ScannerBar, ScannerSession } from './engine';
import { sessionSegment } from '../core/exchange-session';

const minute = 60_000;
const today: ScannerSession = { date: '2026-09-17', open: Date.parse('2026-09-17T13:30:00Z'), close: Date.parse('2026-09-17T20:00:00Z') };
function path(session = today, count = 60, step = 0.03, volume = 5000, initial = 100): ScannerBar[] {
  return Array.from({ length: count }, (_, index) => { const o = initial + index * step, c = initial + (index + 1) * step; return { t: new Date(session.open + index * minute).toISOString(), o, h: Math.max(o, c) + 0.01, l: Math.min(o, c) - 0.01, c, v: volume, vw: (o + c) / 2 }; });
}
function history(count = 20): HistoricalScannerSession[] {
  return Array.from({ length: count }, (_, index) => { const open = today.open - (index + 1) * 86_400_000; const session = { date: new Date(open).toISOString().slice(0, 10), open, close: open + 390 * minute }; return { session, bars: path(session, 390, 0, 2000), complete: true }; });
}
const quote: QuoteMetrics = { valid: true, currentSpreadBps: 2, medianSpreadBps: 2, quoteAgeSeconds: 0.5, validSamples: 60, reasons: [] };
const profile = buildVolumeProfile(today, history());
function evaluate(bars = path(), overrides: Partial<Parameters<typeof evaluateScanner>[0]> = {}) { return evaluateScanner({ symbol: 'TEST', bars, session: today, evaluationTime: today.open + 60 * minute, profile, quote, eligible: true, ...overrides }); }

describe('sparse extended-session observations', () => {
  const session = sessionSegment({ date: '2026-09-21', open: Date.parse('2026-09-21T13:30:00Z'), close: Date.parse('2026-09-21T20:00:00Z') }, 'overnight');
  const sparse = (bars: ScannerBar[]) => bars.filter((_, index) => index % 5 !== 1);
  const baseline = history().map(item => {
    const segment = sessionSegment(item.session, 'overnight');
    return { session: segment, bars: sparse(path(segment, 480, 0, 2000)), complete: true, regularSession: item.session, regularBars: item.bars };
  });
  const overnightProfile = buildVolumeProfile(session, baseline);
  const evaluationTime = Date.parse('2026-09-21T07:00:00Z'); // Monday 09:00 Berlin / 03:00 New York.
  const current = sparse(path(session, 420));
  const run = (overrides: Partial<Parameters<typeof evaluateScanner>[0]> = {}) => evaluate(current, { session, evaluationTime, barsCoveredThrough: evaluationTime, profile: overnightProfile, ...overrides });

  it('builds matching volume slots from complete sparse responses, retaining the regular-session liquidity check', () => {
    expect(overnightProfile).toMatchObject({ valid: true, sampleCount: 20 });
    expect(overnightProfile.meanMinuteVolume.slice(0, 7)).toEqual([2000, 0, 2000, 2000, 2000, 2000, 0]);
    expect(overnightProfile.meanCumulativeVolume[9]).toBe(16_000);
    expect(overnightProfile.averageDailyRthDollarVolume).toBe(78_000_000);
    expect(buildVolumeProfile(session, baseline.slice(0, 10).map((item, i) => ({ ...item, complete: i !== 0 }))).valid).toBe(false);
    expect(buildVolumeProfile(session, baseline.map(item => ({ ...item, regularBars: [] }))).valid).toBe(false);
    expect(buildVolumeProfile(session, baseline.map(item => ({ ...item, bars: [] }))).valid).toBe(false);
  });

  it('qualifies at Monday 09:00 Berlin without filling omitted candles or stretching volume windows', () => {
    const result = run();
    expect(result.qualified).toBe(true);
    expect(result.features.sessionRVOL).toBe(2.5);
    expect(result.features.recentRVOL10).toBe(2.5);
    expect(result.features.dollarVolume5m).toBeCloseTo(current.filter(bar => Date.parse(bar.t) >= evaluationTime - 5 * minute).reduce((sum, bar) => sum + bar.v * bar.vw!, 0));
    expect(result.features.return30).toBeCloseTo(112.6 / 111.7 - 1);
    expect(current).toHaveLength(336);
  });

  it('requires verified omissions, a fresh last bar, valid quotes, and sufficient recent observations', () => {
    expect(run({ barsCoveredThrough: undefined }).dataStatus).toBe('unavailable');
    expect(run({ barsCoveredThrough: evaluationTime - 10 * minute }).dataStatus).toBe('unavailable');
    expect(run({ bars: current.slice(0, -1) }).dataStatus).toBe('unavailable');
    expect(run({ bars: current.filter((_, index) => index % 2 === 0) }).qualified).toBe(false);
    expect(run({ quote: { ...quote, valid: false, quoteAgeSeconds: 20, reasons: ['Stale quote'] } }).qualified).toBe(false);
    expect(run({ bars: current.map((bar, index) => index === 10 ? { ...bar, vw: null } : bar) }).dataStatus).toBe('unavailable');
  });

  it('fits real elapsed timestamps rather than compressing thirty minutes into the last thirty trades', () => {
    const exponential = path(session, 60).map((bar, index) => ({ ...bar, o: 100 * Math.exp(index * .001), c: 100 * Math.exp((index + 1) * .001), h: 110, l: 90 }));
    const result = calculateWindow(sparse(exponential), 30, session.open + 60 * minute, true);
    expect(result?.slope).toBeCloseTo(.001, 12);
    expect(result?.r2).toBeCloseTo(1, 12);
    expect(result?.return).toBeCloseTo(Math.exp(.03) - 1, 12);
    expect(calculateWindow(exponential.filter((_, index) => index < 40 || index > 43), 30, session.open + 60 * minute, true)).toBeNull();
  });
});

describe('scanner feature mathematics (finalized synthetic bars)', () => {
  it('qualifies a smooth upward path with activity and liquid spreads, even below yesterday close', () => {
    const result = evaluate(path(), { priorClose: 110 });
    expect(result.qualified).toBe(true);
    expect(result.features.dailyChange).toBeLessThan(0);
    expect(result.features.return30).toBeCloseTo(101.8 / 100.9 - 1, 10);
    expect(result.features.sessionRVOL).toBe(2.5);
    expect(result.features.recentRVOL10).toBe(2.5);
    expect(result.features.efficiency30).toBeCloseTo(1);
    expect(result.features.r2_30).toBeGreaterThan(0.999);
    expect(result.features.confirmed60).toBe(true);
    expect(result.features.priceTimestamp).toBe('2026-09-17T14:30:00.000Z');
  });
  it('rejects smooth downtrends and flat prices without a perfect constant-price score', () => {
    const down = evaluate(path(today, 60, -0.03));
    expect(down.qualified).toBe(false);
    expect(down.features.efficiency30).toBeCloseTo(1);
    expect(down.features.r2_30).toBeGreaterThan(0.999);
    const flat = evaluate(path(today, 60, 0));
    expect(flat.qualified).toBe(false);
    expect(flat.features.r2_30).toBe(0);
    expect(flat.features.efficiency30).toBe(0);
    expect(flat.features.slope30).toBe(0);
    expect(flat.features.jumpShare).toBeNull();
    expect(JSON.stringify(flat)).not.toContain('NaN');
  });
  it('uses the first open as p0 for exactly N minutes', () => {
    const bars = path(today, 30, 0.1);
    expect(calculateWindow(bars, 30)?.return).toBeCloseTo(0.03);
    expect(calculateWindow(bars, 31)).toBeNull();
    expect(calculateWindow([...bars.slice(0, 10), ...bars.slice(11)], 29)).toBeNull();
  });
  it('scores a choppy path below a smooth path with the same net gain', () => {
    const smooth = path();
    const choppy = path().map((bar, i) => { const c = bar.c + (i % 2 === 0 ? 0.4 : 0); return { ...bar, c, h: Math.max(bar.h, c + 0.01) }; });
    expect(choppy.at(-1)?.c).toBe(smooth.at(-1)?.c);
    const s = evaluate(smooth), c = evaluate(choppy);
    expect(c.features.return30).toBeCloseTo(s.features.return30!);
    expect(scoreScanner(c.features)!.score).toBeLessThan(scoreScanner(s.features)!.score);
  });
  it('rejects an opening surge followed by inactivity and a single jump followed by flat prices', () => {
    const inactive = path(today, 60, 0, 100);
    inactive[0] = { ...inactive[0], o: 90, h: 101, l: 89, c: 100, vw: 99, v: 1_000_000 };
    const result = evaluate(inactive);
    expect(result.qualified).toBe(false);
    expect(result.features.recentRVOL10).toBe(0.05);
    const jump = path(today, 30, 0).map((bar, i) => i < 15 ? bar : { ...bar, o: i === 15 ? 100 : 105, c: 105, h: 105.01, l: i === 15 ? 99.99 : 104.99, vw: 105 });
    const jumped = evaluate(jump, { evaluationTime: today.open + 30 * minute });
    expect(jumped.features.jumpShare).toBe(1);
    expect(jumped.qualified).toBe(false);
  });
  it('uses the exact same historical minute/window for RVOL', () => {
    const h = history().map(item => ({ ...item, bars: item.bars.map((bar, index) => ({ ...bar, v: index < 50 ? 1000 : 4000 })) }));
    const result = evaluate(path(), { profile: buildVolumeProfile(today, h) });
    expect(result.features.sessionRVOL).toBeCloseTo(300_000 / 90_000);
    expect(result.features.recentRVOL10).toBeCloseTo(50_000 / 40_000);
  });
  it('uses contemporaneous session VWAP for every historical close', () => {
    const bars = path(today, 30, 0.1);
    bars[29] = { ...bars[29], c: 200, h: 201, vw: 199, v: 10_000_000 };
    const result = evaluate(bars, { evaluationTime: today.open + 30 * minute });
    expect(result.features.sessionVWAP).toBeGreaterThan(190);
    expect(result.features.vwapHold30).toBe(1);
  });
  it('uses fractional returns, dollar volume, and basis points in qualification', () => {
    const result = evaluate();
    expect(result.features.return30).toBeLessThan(0.01);
    expect(result.features.dollarVolume5m).toBeCloseTo(path().slice(-5).reduce((sum, bar) => sum + bar.v * bar.vw!, 0));
    const stricter = validateScannerConfig({ minimumMoveToSpreadMultiple: 50 });
    expect(evaluate(path(), { config: stricter }).qualified).toBe(false);
  });
  it('keeps extension separate from qualification and seeds EMA/ATR explicitly', () => {
    const bars = path(today, 60, 0.1);
    const narrow = evaluate(bars), wide = evaluate(bars.map(bar => ({ ...bar, h: bar.h + 2, l: bar.l - 2 })));
    expect(narrow.qualified).toBe(true);
    expect(wide.qualified).toBe(true);
    expect(narrow.features.extended).toBe(true);
    expect(wide.features.extended).toBe(false);
    expect(narrow.score).toBe(wide.score);
    expect(calculateEMA(path(today, 9, 1))).toBe(105);
    expect(calculateEMA(path(today, 8))).toBeNull();
    expect(calculateATR(path(today, 14, 1))).toBeCloseTo(1.02);
    const rangeChange = path(today, 15, 1); rangeChange[14].h += 14;
    expect(calculateATR(rangeChange)).toBeCloseTo(2.02);
  });
  it('bounds score components, preserves prior numeric ties and falls back to symbol', () => {
    const a = evaluate(path(), { symbol: 'AAA' }), b = evaluate(path(), { symbol: 'BBB' });
    expect(a.score).toBeGreaterThanOrEqual(0); expect(a.score).toBeLessThanOrEqual(100);
    expect(Object.values(a.components!).reduce((sum, value) => sum + value, 0)).toBe(a.score);
    expect(rankEvaluations([b, a]).map(row => row.symbol)).toEqual(['AAA', 'BBB']);
    expect(rankEvaluations([a, b], ['BBB', 'AAA']).map(row => row.symbol)).toEqual(['BBB', 'AAA']);
    expect(scoreScanner({ ...a.features, sessionRVOL: Infinity })).toBeNull();
  });
});

describe('scanner session/data quality', () => {
  it('excludes current/future and early-close sessions from the twenty-session baseline', () => {
    const current = { session: today, bars: path(today, 390), complete: true };
    const futureSession = { date: '2026-09-18', open: today.open + 86_400_000, close: today.close + 86_400_000 };
    const early = history(1)[0]; early.session = { ...early.session, close: early.session.open + 210 * minute };
    const h = [early, ...history(21).slice(1), current, { session: futureSession, bars: path(futureSession, 390), complete: true }];
    const p = buildVolumeProfile(today, h);
    expect(p.sampleCount).toBe(20);
    expect(p.sessionDates.every(date => date < today.date)).toBe(true);
    expect(p.sessionDates).not.toContain(futureSession.date);
    expect(p.sessionDates).not.toContain(early.session.date);
  });
  it('requires complete requests and actual full-length coverage; absent pages are not zero volume', () => {
    const missingPage = history(10); missingPage[0].complete = false;
    expect(buildVolumeProfile(today, missingPage).valid).toBe(false);
    const missingBar = history(10); missingBar[0].bars.splice(100, 1);
    expect(buildVolumeProfile(today, missingBar).sampleCount).toBe(9);
    const missingVwap = history(10); missingVwap[0].bars[0].vw = null;
    expect(buildVolumeProfile(today, missingVwap).valid).toBe(false);
    expect(evaluate(path(), { profile: null }).dataStatus).toBe('loading-history');
  });
  it('does not double count duplicate/revised minutes and ignores out-of-order input', () => {
    const bars = path();
    const revised = { ...bars[0], v: 10_000 };
    const result = evaluate([...bars.slice().reverse(), bars[0], revised]);
    expect(result.features.sessionRVOL).toBeCloseTo(305_000 / 120_000);
    expect(completedSessionBars([...bars, revised], today, today.open + 60 * minute)).toHaveLength(60);
  });
  it('excludes extended-hours/future bars and never borrows prior-session windows', () => {
    const bars = path();
    const extended = [{ ...bars[0], t: new Date(today.open - minute).toISOString(), v: 1e10 }, { ...bars[0], t: new Date(today.close).toISOString(), v: 1e10 }];
    const future = path(today, 61).at(-1)!;
    expect(evaluate([...bars, ...extended, future]).features.sessionRVOL).toBe(2.5);
    const incomplete = [...history(1)[0].bars, ...path(today, 29)];
    expect(evaluate(incomplete, { evaluationTime: today.open + 29 * minute }).dataStatus).toBe('forming');
    expect(evaluate(incomplete).hardFailure).toBe(true);
  });
  it('fails missing or invalid current bars/VWAP instead of smoothing gaps', () => {
    const missing = path(); missing.splice(12, 1);
    expect(evaluate(missing).hardFailure).toBe(true);
    const noVwap = path(); noVwap[50].vw = null;
    expect(evaluate(noVwap).dataStatus).toBe('unavailable');
    const invalid = path(); invalid[20].c = NaN;
    expect(evaluate(invalid).qualified).toBe(false);
  });
  it('uses the supplied calendar boundaries for DST and current early closes', () => {
    const winter = { date: '2026-11-02', open: Date.parse('2026-11-02T14:30:00Z'), close: Date.parse('2026-11-02T21:00:00Z') };
    const early = { ...today, close: today.open + 210 * minute };
    expect(evaluate(path(winter), { session: winter, evaluationTime: winter.open + 60 * minute }).qualified).toBe(true);
    expect(evaluate(path(), { session: early, evaluationTime: early.close }).dataStatus).toBe('closed');
    expect(evaluate(path(), { evaluationTime: today.open - 1 }).dataStatus).toBe('closed');
  });
  it('keeps sixty-minute confirmation absent before sixty actual current-session bars', () => {
    const result = evaluate(path(today, 35), { evaluationTime: today.open + 35 * minute });
    expect(result.qualified).toBe(true); expect(result.features.slope60).toBeNull(); expect(result.features.confirmed60).toBe(false);
  });
});

describe('quote sampler arrival-time replay', () => {
  it('requires 45 actual one-second samples and rejects stale/future/invalid/locked/crossed quotes', () => {
    const sampler = new QuoteSampler();
    let now = today.open;
    for (let second = 0; second < 44; second++) { now = today.open + second * 1000; sampler.ingest({ t: new Date(now).toISOString(), bp: 99.99, ap: 100.01, bs: 100, as: 100 }); sampler.sample(now); }
    expect(sampler.metrics(now).valid).toBe(false);
    now += 1000; sampler.ingest({ t: new Date(now).toISOString(), bp: 99.99, ap: 100.01, bs: 100, as: 100 }); sampler.sample(now);
    expect(sampler.metrics(now).valid).toBe(true); expect(sampler.metrics(now).medianSpreadBps).toBeCloseTo(2);
    expect(sampler.metrics(now + 5001).valid).toBe(false);
    for (const bad of [{ bp: 100, ap: 100, bs: 1, as: 1 }, { bp: 101, ap: 100, bs: 1, as: 1 }, { bp: 99, ap: 100, bs: 0, as: 1 }, { bp: NaN, ap: 100, bs: 1, as: 1 }]) { sampler.ingest({ t: new Date(now).toISOString(), ...bad }); expect(sampler.metrics(now).valid).toBe(false); }
    sampler.ingest({ t: new Date(now + 1).toISOString(), bp: 99.99, ap: 100.01, bs: 1, as: 1 }); expect(sampler.metrics(now).valid).toBe(false);
  });
  it('weights seconds equally, ignores out-of-order quotes and never fills missed samples', () => {
    const sampler = new QuoteSampler();
    for (let second = 0; second < 60; second++) {
      const now = today.open + second * 1000;
      sampler.ingest({ t: new Date(now).toISOString(), bp: 99.99, ap: 100.01, bs: 100, as: 100 });
      sampler.sample(now);
      if (second === 50) for (let burst = 0; burst < 1000; burst++) { sampler.ingest({ t: new Date(now).toISOString(), bp: 99.96, ap: 100.04, bs: 100, as: 100 }); sampler.sample(now); }
    }
    expect(sampler.metrics(today.open + 59_000).validSamples).toBe(60);
    expect(sampler.metrics(today.open + 59_000).medianSpreadBps).toBeCloseTo(2);
    sampler.ingest({ t: new Date(today.open).toISOString(), bp: 1, ap: 10, bs: 1, as: 1 });
    expect(sampler.metrics(today.open + 59_000).currentSpreadBps).toBeCloseTo(2);
    sampler.sample(today.open + 119_000);
    expect(sampler.metrics(today.open + 119_000).validSamples).toBe(0);
  });
  it('never treats warming quotes or forged stale quote metrics as qualified', () => {
    expect(evaluate(path(), { quote: null }).dataStatus).toBe('warming-quotes');
    expect(evaluate(path(), { quote: { ...quote, quoteAgeSeconds: 6 } }).hardFailure).toBe(true);
    expect(evaluate(path(), { quote: { ...quote, currentSpreadBps: 0 } }).qualified).toBe(false);
    expect(evaluate(path(), { quote: { ...quote, medianSpreadBps: 11 } }).qualified).toBe(false);
  });
});

describe('scanner config validation', () => {
  it('provides all defaults and rejects invalid units, bounds, and normalization anchors', () => {
    expect(validateScannerConfig()).toEqual(DEFAULT_SCANNER_CONFIG);
    for (const input of [{ minSessionRVOL: NaN }, { maxResults: 0 }, { minEfficiency30: 1.1 }, { baselineMinSessions: 9 }, { barGraceSeconds: 60 }, { anchors: { ...DEFAULT_SCANNER_CONFIG.anchors, sessionRVOL: [0, 4] as [number, number] } }]) expect(() => validateScannerConfig(input)).toThrow();
  });
});
