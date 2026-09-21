import { describe, expect, it, vi } from 'vitest';
import type { DataReads } from '../broker/reads';
import { RobotData } from './robot-data';

const at = Date.parse('2026-09-21T14:30:06Z'), interval = 300_000;
const bar = (time: number, close = 100) => ({ t: new Date(time).toISOString(), o: 100, c: close, h: Math.max(100, close), l: Math.min(100, close), v: 100, vw: 100 });
function setup() {
  let now = at;
  const data = { getEligibleAssets: vi.fn<DataReads['getEligibleAssets']>(async () => []), getCalendar: vi.fn<DataReads['getCalendar']>(async () => []),
    getBars: vi.fn<DataReads['getBars']>(async () => ({ SPY: [bar(at - 6000 - interval)] })) };
  const controller = new AbortController();
  return { data, controller, setTime: (at: number) => { now = at; }, cache: new RobotData(data as unknown as DataReads, controller.signal, () => now) };
}
describe('shared Robot execution history', () => {
  it('shares simultaneous metadata requests and reuses successful observations with their original timestamps', async () => {
    const h = setup();
    await Promise.all(Array.from({ length: 20 }, () => Promise.all([h.cache.eligibleAssets(), h.cache.calendar('2026-09-21')])));
    expect(h.data.getEligibleAssets).toHaveBeenCalledOnce(); expect(h.data.getCalendar).toHaveBeenCalledOnce();
    h.setTime(at + 15_000); expect((await h.cache.calendar('2026-09-21')).at).toBe(at); await h.cache.eligibleAssets();
    expect(h.data.getEligibleAssets).toHaveBeenCalledOnce();
    h.setTime(at + 60_000); await h.cache.calendar('2026-09-21'); await h.cache.eligibleAssets();
    expect(h.data.getCalendar).toHaveBeenCalledTimes(2); expect(h.data.getEligibleAssets).toHaveBeenCalledTimes(2);
  });
  it('reuses completed five-minute bars, then fetches an overlap for revisions instead of seven days', async () => {
    const h = setup(), initial = await h.cache.bars('SPY', '2026-09-21', true);
    for (let tick = 1; tick < 60; tick++) { h.setTime(at + tick * 5000); expect(await h.cache.bars('SPY', '2026-09-21', true)).toEqual(initial); }
    expect(h.data.getBars).toHaveBeenCalledOnce();
    h.setTime(at + interval);
    h.data.getBars.mockResolvedValue({ SPY: [bar(at - 6000 - interval, 101), bar(at - 6000, 102)] });
    const revised = await h.cache.bars('SPY', '2026-09-21', true);
    expect(revised.map(value => value.c)).toEqual([101, 102]);
    expect(h.data.getBars.mock.calls[1][1]).toMatchObject({ start: at - 6000 - 2 * interval, end: at - 6000 + interval, includeOvernight: true });
    h.setTime(at + 15 * 60_000); await h.cache.bars('SPY', '2026-09-21', true);
    expect(h.data.getBars.mock.calls[2][1]).toMatchObject({ start: at + 15 * 60_000 - 7 * 86_400_000 });
  });
  it('never uses old history on a failed refresh, and invalidates caches on connection changes', async () => {
    const h = setup(); await h.cache.bars('SPY', '2026-09-21', false);
    h.setTime(at + interval); h.data.getBars.mockRejectedValueOnce(new Error('missing page'));
    await expect(h.cache.bars('SPY', '2026-09-21', false)).rejects.toThrow('missing page');
    await h.cache.bars('SPY', '2026-09-21', false); expect(h.data.getBars).toHaveBeenCalledTimes(3);
    h.cache.clear(); await h.cache.bars('SPY', '2026-09-21', false);
    expect(h.data.getBars.mock.calls[3][1]).toMatchObject({ start: at + interval - 7 * 86_400_000 });
  });
  it('does not repopulate a cleared cache from an old in-flight response', async () => {
    const h = setup(); let release!: (value: []) => void;
    h.data.getCalendar.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const result = h.cache.calendar('2026-09-21'); h.cache.clear(); release([]);
    await expect(result).rejects.toThrow('cancelled'); await h.cache.calendar('2026-09-21');
    expect(h.data.getCalendar).toHaveBeenCalledTimes(2);
  });
});
