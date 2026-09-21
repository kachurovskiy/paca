import { test, expect } from '@playwright/test';
import { BrokerFixture, MINUTE, watchlistRequest } from './support/broker';

for (const standalone of [false, true]) {
  test(`${standalone ? 'standalone' : 'development'} watchlist keeps Friday's last available day visible on Sunday and during failed refreshes`, async ({ page }) => {
    const broker = new BrokerFixture(true);
    broker.now = Date.parse('2026-09-20T14:30:00Z');
    broker.quoteTimestamp = '2026-09-18T20:00:00Z';
    broker.watchlistBars.SPY = [
      ['2026-09-17T19:50:00Z', 80], ['2026-09-17T19:55:00Z', 100],
      ['2026-09-18T13:30:00Z', 102], ['2026-09-18T19:55:00Z', 101.2],
    ].map(([t, c]) => ({ t: String(t), o: Number(c), h: Number(c), l: Number(c), c: Number(c), v: 100 }));
    await broker.install(page, standalone); await broker.connected(page); await broker.advance(page, 1000);
    const spy = page.getByRole('button', { name: 'Show SPY chart', exact: true });
    await expect(spy.getByRole('img')).toBeVisible();
    await expect(spy.locator('.watchlist-change')).toHaveText('+1.20%');
    const ending = await page.evaluate(timestamp => new Date(timestamp).toLocaleString(), broker.quoteTimestamp);
    await expect(spy.locator('.watchlist-trend')).toHaveAttribute('title', new RegExp(`^24h ending ${ending.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    const path = await spy.locator('svg path').getAttribute('d');
    await expect(spy.locator('svg circle')).toHaveAttribute('cx', '97');

    broker.watchlistFailures.add('SPY'); await broker.advance(page, 120_000);
    await expect(spy.locator('.watchlist-trend')).toHaveAttribute('title', /Refresh unavailable; showing saved history/);
    await expect(spy.locator('svg path')).toHaveAttribute('d', path!);
    await expect(spy.locator('.watchlist-change')).toHaveText('+1.20%');
    broker.watchlistFailures.clear(); broker.watchlistBars.SPY = []; await broker.advance(page, 120_000);
    await expect(spy.locator('.watchlist-trend')).not.toHaveAttribute('title', /Refresh unavailable/);
    await expect(spy.locator('svg path')).toHaveAttribute('d', path!);
    expect(broker.errors).toEqual([]);
  });

  test(`${standalone ? 'standalone' : 'development'} watchlist shows and refreshes 24-hour trends without changing the ticket`, async ({ page }) => {
    const broker = new BrokerFixture(true);
    const history = (start: number) => Array.from({ length: 288 }, (_, index) => {
      const c = start + Math.sin(index / 15);
      return { t: new Date(broker.now - (288 - index) * 5 * MINUTE).toISOString(), o: c, h: c, l: c, c, v: 100 };
    });
    broker.watchlistBars = { SPY: history(100), QQQ: history(110) };
    await broker.install(page, standalone); await broker.connected(page);
    await broker.advance(page, 1000);
    const spy = page.getByRole('button', { name: 'Show SPY chart', exact: true });
    const qqq = page.getByRole('button', { name: 'Show QQQ chart', exact: true });
    await expect(spy.getByRole('img')).toHaveAccessibleName('SPY price over the last available 24 hours');
    await expect(spy).toContainText('+1.20%'); await expect(qqq).toContainText('-8.00%');
    const requests = broker.requests.filter(url => watchlistRequest(url, broker.now));
    expect(requests).toHaveLength(4);
    expect(requests.map(url => url.searchParams.get('feed')).sort()).toEqual(['boats', 'boats', 'sip', 'sip']);
    await page.getByLabel('Quantity', { exact: true }).fill('17');
    broker.watchlistBars.SPY = history(80);
    await broker.advance(page, 120_000);
    // Deliver native HTTP/socket responses, then let the next display timer publish the latest trade.
    await broker.advance(page, 1000);
    await expect(spy).toContainText('+26.50%');
    await expect(page.getByLabel('Quantity', { exact: true })).toHaveValue('17');
    await qqq.click(); await expect(page.getByRole('region', { name: 'QQQ chart', exact: true })).toBeVisible();
    await page.getByLabel('Add ticker').fill('STEADY'); await page.getByRole('button', { name: 'Add symbol' }).click();
    await broker.advance(page, 1000);
    await expect(page.getByRole('button', { name: 'Show STEADY chart', exact: true }).getByRole('img')).toBeVisible();
    await page.getByRole('button', { name: 'Remove QQQ', exact: true }).click();
    await expect(qqq).toHaveCount(0);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    expect(broker.writes).toEqual([]); expect(broker.errors).toEqual([]);
  });
}

test('missing and failed watchlist history stays local and can recover', async ({ page }) => {
  const broker = new BrokerFixture(true); broker.watchlistBars.SPY = []; broker.watchlistFailures.add('QQQ');
  await broker.install(page); await broker.connected(page);
  await broker.advance(page, 1000);
  const spy = page.getByRole('button', { name: 'Show SPY chart', exact: true });
  const qqq = page.getByRole('button', { name: 'Show QQQ chart', exact: true });
  await expect(spy.getByRole('img')).toBeVisible(); await expect(spy.locator('.watchlist-change')).toHaveText('—');
  await expect(qqq).toContainText('24h unavailable');
  await expect(page.getByRole('region', { name: 'SPY chart', exact: true })).toBeVisible();
  delete broker.watchlistBars.SPY; broker.watchlistFailures.clear();
  await broker.advance(page, 120_000);
  await expect(spy.getByRole('img')).toBeVisible(); await expect(qqq.getByRole('img')).toBeVisible();
  expect(broker.errors).toEqual([]);
});
