import { describe, expect, it } from 'vitest';
import { evaluateScanner, validateScannerConfig } from './engine';
import type { ScannerBar, ScannerEvaluation, VolumeProfile } from './engine';
import { createScannerState, updateScannerState } from './state';

const open = Date.parse('2026-09-17T13:30:00Z');
const session = { date: '2026-09-17', open, close: open + 390 * 60_000 };
const profile: VolumeProfile = { valid: true, sampleCount: 20, sessionDates: [], meanMinuteVolume: Array(390).fill(2000), meanCumulativeVolume: Array.from({ length: 390 }, (_, i) => (i + 1) * 2000), averageDailyRthDollarVolume: 78_000_000, reasons: [] };
function bars(minutes: number): ScannerBar[] { return Array.from({ length: minutes }, (_, i) => ({ t: new Date(open + i * 60_000).toISOString(), o: 100 + i * 0.03, c: 100 + (i + 1) * 0.03, h: 100 + (i + 1) * 0.03 + 0.01, l: 100 + i * 0.03 - 0.01, v: 5000, vw: 100 + (i + 0.5) * 0.03 })); }
function evaluated(symbol: string, minutes: number, qualified = true, score = 80): ScannerEvaluation {
  const evaluation = evaluateScanner({ symbol, session, bars: bars(minutes), evaluationTime: open + minutes * 60_000, profile, quote: { valid: true, currentSpreadBps: 2, medianSpreadBps: 2, quoteAgeSeconds: 0, validSamples: 60, reasons: [] }, eligible: true });
  return { ...evaluation, qualified, score, reasons: qualified ? [] : ['Recent RVOL below minimum'], flags: qualified ? ['Clean uptrend'] : [] };
}

describe('scanner distinct-minute state', () => {
  it('admits only after two distinct consecutive evaluations; revisions cannot accelerate admission', () => {
    let state = createScannerState();
    state = updateScannerState(state, [evaluated('AAA', 30)]);
    expect(state.rows).toHaveLength(0);
    for (let revision = 0; revision < 10; revision++) state = updateScannerState(state, [evaluated('AAA', 30)]);
    expect(state.entries.AAA.qualifiedStreak).toBe(1);
    expect(state.rows).toHaveLength(0);
    state = updateScannerState(state, [evaluated('AAA', 31)]);
    expect(state.rows.map(row => row.symbol)).toEqual(['AAA']);
    expect(state.rows[0].state).toBe('clean');
  });
  it('shows Fading immediately on a soft failure and removes after three distinct failures', () => {
    let state = createScannerState();
    state = updateScannerState(state, [evaluated('AAA', 30)]);
    state = updateScannerState(state, [evaluated('AAA', 31)]);
    state = updateScannerState(state, [evaluated('AAA', 32, false)]);
    expect(state.rows[0].state).toBe('fading');
    expect(state.rows[0].evaluation.qualified).toBe(false);
    for (let i = 0; i < 10; i++) state = updateScannerState(state, [evaluated('AAA', 32, false)]);
    expect(state.entries.AAA.failedStreak).toBe(1);
    state = updateScannerState(state, [evaluated('AAA', 33, false)]);
    expect(state.rows).toHaveLength(1);
    state = updateScannerState(state, [evaluated('AAA', 34, false)]);
    expect(state.rows).toHaveLength(0);
  });
  it('revalidates a revised minute against its prior-minute baseline', () => {
    let state = createScannerState();
    state = updateScannerState(state, [evaluated('AAA', 30)]);
    state = updateScannerState(state, [evaluated('AAA', 31)]);
    expect(state.rows).toHaveLength(1);
    state = updateScannerState(state, [evaluated('AAA', 31, false)]);
    expect(state.rows[0].state).toBe('fading');
    expect(state.rows[0].evaluation.qualified).toBe(false);
    expect(state.entries.AAA.qualifiedStreak).toBe(0);
    state = updateScannerState(state, [evaluated('AAA', 31)]);
    expect(state.entries.AAA.qualifiedStreak).toBe(2);
    expect(state.rows[0].state).toBe('clean');
  });
  it('hard invalidates on a same-minute outage/halt and requires readmission on recovery', () => {
    let state = createScannerState();
    state = updateScannerState(state, [evaluated('AAA', 30)]);
    state = updateScannerState(state, [evaluated('AAA', 31)]);
    state = updateScannerState(state, [{ ...evaluated('AAA', 31, false), hardFailure: true, reasons: ['Known trading halt'] }]);
    expect(state.rows).toHaveLength(0);
    state = updateScannerState(state, [evaluated('AAA', 31)]);
    expect(state.rows).toHaveLength(0);
    expect(state.entries.AAA.qualifiedStreak).toBe(1);
    state = updateScannerState(state, [evaluated('AAA', 32)]);
    expect(state.rows).toHaveLength(1);
  });
  it('rejects out-of-order old evaluations and does not call missed minutes consecutive', () => {
    let state = createScannerState();
    state = updateScannerState(state, [evaluated('AAA', 30)]);
    state = updateScannerState(state, [evaluated('AAA', 32)]);
    expect(state.rows).toHaveLength(0);
    state = updateScannerState(state, [evaluated('AAA', 31)]);
    expect(state.entries.AAA.lastMinute).toBe(Math.floor((open + 32 * 60_000) / 60_000));
    state = updateScannerState(state, [evaluated('AAA', 33)]);
    expect(state.rows).toHaveLength(1);
  });
  it('resets qualification state on configuration changes and session rollover', () => {
    let state = createScannerState();
    state = updateScannerState(state, [evaluated('AAA', 30)]);
    state = updateScannerState(state, [evaluated('AAA', 31)]);
    const config = validateScannerConfig({ version: 2 });
    state = updateScannerState(state, [{ ...evaluated('AAA', 32), configVersion: 2 }], config);
    expect(state.rows).toHaveLength(0);
    expect(state.entries.AAA.qualifiedStreak).toBe(1);
    state = updateScannerState(state, [{ ...evaluated('AAA', 33), configVersion: 2, sessionDate: '2026-09-18' }], config);
    expect(state.rows).toHaveLength(0);
    expect(state.sessionDate).toBe('2026-09-18');
  });
});

describe('visible cutoff hysteresis', () => {
  it('requires a score margin and persistence to replace a valid incumbent', () => {
    const config = validateScannerConfig({ maxResults: 1 });
    let state = createScannerState(config);
    for (const time of [30, 31]) state = updateScannerState(state, [evaluated('AAA', time, true, 80)], config);
    state = updateScannerState(state, [evaluated('AAA', 32, true, 80), evaluated('BBB', 32, true, 82)], config);
    state = updateScannerState(state, [evaluated('AAA', 33, true, 80), evaluated('BBB', 33, true, 82)], config);
    expect(state.visible).toEqual(['AAA']);
    state = updateScannerState(state, [evaluated('AAA', 34, true, 80), evaluated('BBB', 34, true, 90)], config);
    for (let revision = 0; revision < 5; revision++) state = updateScannerState(state, [evaluated('BBB', 34, true, 90)], config);
    expect(state.visible).toEqual(['AAA']);
    expect(state.cutoffChallenges.BBB.minutes).toBe(1);
    state = updateScannerState(state, [evaluated('AAA', 35, true, 80), evaluated('BBB', 35, true, 90)], config);
    expect(state.visible).toEqual(['BBB']);
  });
  it('does not preserve the Clean label for a fading incumbent at the cutoff', () => {
    const config = validateScannerConfig({ maxResults: 1 });
    let state = createScannerState(config);
    for (const time of [30, 31]) state = updateScannerState(state, [evaluated('AAA', time, true, 90), evaluated('BBB', time, true, 80)], config);
    expect(state.visible).toEqual(['AAA']);
    state = updateScannerState(state, [evaluated('AAA', 32, false, 90), evaluated('BBB', 32, true, 80)], config);
    expect(state.visible).toEqual(['BBB']);
    expect(state.entries.AAA.state).toBe('fading');
    expect(state.rows.every(row => row.state !== 'clean' || row.evaluation.qualified)).toBe(true);
  });
  it('reorders only on distinct minutes and keeps numeric ties deterministic', () => {
    let state = createScannerState();
    for (const time of [30, 31]) state = updateScannerState(state, [evaluated('BBB', time), evaluated('AAA', time)]);
    expect(state.visible).toEqual(['AAA', 'BBB']);
    state = updateScannerState(state, [evaluated('BBB', 31, true, 99)]);
    expect(state.visible).toEqual(['AAA', 'BBB']);
    state = updateScannerState(state, [evaluated('AAA', 32), evaluated('BBB', 32, true, 99)]);
    expect(state.visible).toEqual(['BBB', 'AAA']);
    state = updateScannerState(state, [evaluated('AAA', 33), evaluated('BBB', 33)]);
    expect(state.visible).toEqual(['BBB', 'AAA']);
  });
});

describe('recently qualified discoveries', () => {
  it('keeps hard-invalidated discoveries separate from live rows with their latest reason', () => {
    let state = createScannerState();
    for (const time of [30, 31]) state = updateScannerState(state, [evaluated('AAA', time)]);
    const invalid = { ...evaluated('AAA', 31, false), hardFailure: true, reasons: ['Stale or invalid quote timestamp'] };
    state = updateScannerState(state, [invalid]);
    expect(state.rows).toHaveLength(0);
    expect(state.recentRows).toHaveLength(1);
    expect(state.recentRows[0]).toMatchObject({ symbol: 'AAA', lastQualifiedAt: open + 31 * 60_000, admitted: false, state: 'unavailable' });
    expect(state.recentRows[0].evaluation.reasons).toEqual(['Stale or invalid quote timestamp']);
    state = updateScannerState(state, [{ ...invalid, reasons: ['Known trading halt'] }]);
    expect(state.recentRows[0].evaluation.reasons).toEqual(['Known trading halt']);
    expect(state.recentRows[0].lastQualifiedAt).toBe(open + 31 * 60_000);
    state = updateScannerState(state, [evaluated('AAA', 31)]);
    expect(state.rows).toHaveLength(0);
    expect(state.recentRows).toHaveLength(1);
    state = updateScannerState(state, [evaluated('AAA', 32)]);
    expect(state.rows.map(row => row.symbol)).toEqual(['AAA']);
    expect(state.recentRows).toHaveLength(0);
  });
  it('retains a fading row only after its live grace period ends and excludes never-admitted candidates', () => {
    let state = createScannerState();
    for (const time of [30, 31]) state = updateScannerState(state, [evaluated('AAA', time)]);
    for (const time of [32, 33]) {
      state = updateScannerState(state, [evaluated('AAA', time, false)]);
      expect(state.rows[0].state).toBe('fading');
      expect(state.recentRows).toHaveLength(0);
    }
    state = updateScannerState(state, [evaluated('AAA', 34, false), evaluated('BBB', 34)]);
    expect(state.rows).toHaveLength(0);
    expect(state.recentRows.map(row => row.symbol)).toEqual(['AAA']);
    expect(state.recentRows[0].lastQualifiedAt).toBe(open + 31 * 60_000);
  });
  it('expires after fifteen minutes without a new qualification and bounds the newest discoveries', () => {
    const config = validateScannerConfig({ maxResults: 1 });
    let state = createScannerState(config);
    for (const time of [30, 31]) state = updateScannerState(state, [evaluated('AAA', time)], config);
    state = updateScannerState(state, [{ ...evaluated('AAA', 32, false), hardFailure: true }, evaluated('BBB', 32)], config);
    state = updateScannerState(state, [evaluated('BBB', 33)], config);
    state = updateScannerState(state, [{ ...evaluated('BBB', 34, false), hardFailure: true }], config);
    expect(state.recentRows.map(row => row.symbol)).toEqual(['BBB']);
    state = updateScannerState(state, [evaluated('OTHER', 47, false)], config);
    expect(state.recentRows.map(row => row.symbol)).toEqual(['BBB']);
    state = updateScannerState(state, [{ ...evaluated('OTHER', 47, false), evaluationTime: open + 48 * 60_000 }], config);
    expect(state.recentRows).toHaveLength(0);
  });
  it('clears recent discoveries on configuration changes and session rollover', () => {
    let state = createScannerState();
    for (const time of [30, 31]) state = updateScannerState(state, [evaluated('AAA', time)]);
    state = updateScannerState(state, [{ ...evaluated('AAA', 32, false), hardFailure: true }]);
    expect(state.recentRows).toHaveLength(1);
    const config = validateScannerConfig({ version: 2 });
    const reconfigured = updateScannerState(state, [{ ...evaluated('AAA', 33), configVersion: 2 }], config);
    expect(reconfigured.recentRows).toHaveLength(0);
    const nextSession = updateScannerState(state, [{ ...evaluated('AAA', 33), sessionDate: '2026-09-18' }]);
    expect(nextSession.recentRows).toHaveLength(0);
  });
});

describe('fake-clock completed-minute replay', () => {
  it('replays a late bar and same-minute revision without lookahead or duplicate admission', () => {
    let fakeNow = open + 30 * 60_000;
    let delivered = bars(29);
    const evaluateArrival = () => evaluateScanner({ symbol: 'REPLAY', bars: delivered, session, evaluationTime: fakeNow, profile, quote: { valid: true, currentSpreadBps: 2, medianSpreadBps: 2, quoteAgeSeconds: 0, validSamples: 60, reasons: [] }, eligible: true });
    let state = createScannerState();
    state = updateScannerState(state, [evaluateArrival()]);
    expect(state.entries.REPLAY.evaluation.hardFailure).toBe(true);
    delivered = bars(31); // Includes a forming minute; it cannot affect evaluation at minute 30.
    state = updateScannerState(state, [evaluateArrival()]);
    expect(state.entries.REPLAY.qualifiedStreak).toBe(1);
    const revision = { ...delivered[29], v: 6000 };
    delivered.push(revision);
    state = updateScannerState(state, [evaluateArrival()]);
    expect(state.entries.REPLAY.qualifiedStreak).toBe(1);
    expect(state.entries.REPLAY.evaluation.features.sessionRVOL).toBeCloseTo(151_000 / 60_000);
    fakeNow += 60_000;
    state = updateScannerState(state, [evaluateArrival()]);
    expect(state.rows.map(row => row.symbol)).toEqual(['REPLAY']);
  });
});
