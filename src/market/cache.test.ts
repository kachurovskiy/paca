import { describe, expect, it } from 'vitest';
import { ScannerBarStore, ScannerCache } from './cache';
import type { ScannerBar } from '../scanner/types';

const open = Date.parse('2026-09-17T13:30:00Z');
const bar = (volume: number, offset = 0): ScannerBar => ({ t: new Date(open + offset).toISOString(), o: 100, h: 102, l: 99, c: 101, v: volume, vw: 100.5 });

describe('SIP bar-store arrival replay (events, revisions, and overlapping REST)', () => {
  it('records complete REST coverage without fabricating bars or bridging unknown gaps', () => {
    const store = new ScannerBarStore(open, open + 10 * 60_000);
    store.mergeRest('UP', [bar(100)], 0);
    expect(store.coveredThrough('UP')).toBe(open);
    store.mergeRest('UP', [], 0, { start: open, end: open + 3 * 60_000 });
    expect(store.coveredThrough('UP')).toBe(open + 3 * 60_000);
    store.mergeRest('UP', [bar(100, 5 * 60_000)], 0, { start: open + 5 * 60_000, end: open + 6 * 60_000 });
    expect(store.coveredThrough('UP')).toBe(open + 3 * 60_000);
    store.mergeLive('UP', bar(100, 3 * 60_000), false);
    store.mergeLive('UP', bar(100, 4 * 60_000), false);
    store.mergeRest('UP', [], store.watermark(), { start: open + 5 * 60_000, end: open + 6 * 60_000 });
    expect(store.coveredThrough('UP')).toBe(open + 6 * 60_000);
    expect(store.bars('UP')).toHaveLength(4);
    store.retain(new Set());
    expect(store.coveredThrough('UP')).toBe(open);
  });

  it('replaces duplicate/revised minutes and protects live events arriving during a REST request', () => {
    const store = new ScannerBarStore(open, open + 390 * 60_000);
    const request = store.watermark();
    store.mergeLive('UP', bar(100), false);
    expect(store.mergeLive('UP', bar(120), true)).toBe(true);
    store.mergeRest('UP', [bar(90)], request);
    store.mergeLive('UP', bar(100), false);
    expect(store.bars('UP')).toEqual([bar(120)]);
    expect(store.mergeLive('UP', bar(120), true)).toBe(false);
    expect(store.bars('UP').reduce((sum, value) => sum + value.v, 0)).toBe(120);
    // An eventually-consistent REST page has no revision timestamp, even if
    // requested after receipt; it cannot prove it supersedes updatedBars.
    store.mergeRest('UP', [bar(90)], store.watermark());
    expect(store.bars('UP')[0].v).toBe(120);
  });
  it('merges out-of-order new minutes and excludes premarket, after-hours and fractional timestamps', () => {
    const store = new ScannerBarStore(open, open + 2 * 60_000);
    store.mergeLive('UP', bar(200, 60_000), false);
    store.mergeLive('UP', bar(100), false);
    store.mergeLive('UP', bar(500, -60_000), false);
    store.mergeLive('UP', bar(500, 120_000), false);
    store.mergeLive('UP', bar(500, 1), false);
    expect(store.bars('UP').map(value => value.v)).toEqual([100, 200]);
  });
  it('allows a fresh recovery request to replace old data, but preserves a simultaneous revision', () => {
    const store = new ScannerBarStore(open, open + 390 * 60_000);
    store.mergeLive('UP', bar(100), false);
    const request = store.watermark();
    store.mergeLive('UP', bar(250, 60_000), true);
    store.mergeRest('UP', [bar(110), bar(200, 60_000)], request);
    expect(store.bars('UP').map(value => value.v)).toEqual([110, 250]);
  });
});

describe('bounded session scanner cache', () => {
  it('starts cold in a new session and expires and invalidates split-affected profiles', () => {
    const cache = new ScannerCache();
    cache.set('profile:UP:today', { fingerprint: 'before split' }, 100, 1);
    expect(cache.get('profile:UP:today', 2)).toEqual({ fingerprint: 'before split' });
    expect(new ScannerCache().get('profile:UP:today', 2)).toBeNull();
    cache.invalidate('profile:UP:', 3);
    expect(cache.get('profile:UP:today', 4)).toBeNull();
    cache.set('history', [1, 2], 10, 4);
    expect(cache.get('history', 10)).toBeNull();
  });
  it('evicts least-recent entries and refuses an oversized value', () => {
    const cache = new ScannerCache(150);
    cache.set('first', 'x'.repeat(60), 100, 1);
    cache.set('second', 'y'.repeat(60), 100, 2);
    expect(cache.get('first', 3)).toBeNull();
    expect(cache.get('second', 3)).toBe('y'.repeat(60));
    cache.set('oversize', 'z'.repeat(100), 100, 3);
    expect(cache.get('oversize', 4)).toBeNull();
  });
});
