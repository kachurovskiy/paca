import { test, expect } from '@playwright/test';
import { BrokerFixture } from './support/broker';

for (const standalone of [false, true]) test(`${standalone ? 'standalone' : 'development'} P/L chart excludes transfers, preserves losses, and switches to equity without more requests`, async ({ page }, testInfo) => {
  const broker = new BrokerFixture(); await broker.install(page, standalone);
  const requests: URL[] = [];
  await page.route('**/v2/account/portfolio/history?*', route => {
    requests.push(new URL(route.request().url()));
    return route.fulfill({ json: {
      timestamp: [4, 3, 2, 1, 0].map(hours => Math.floor(broker.now / 1000) - hours * 3600),
      equity: [100000, 150000, 150500, 130500, 129750], profit_loss: [0, 50000, 50500, 30500, 29750],
      base_value: 100000, base_value_asof: '2026-09-16',
      cashflow: { CSD: [0, 50000, 0, 0, 0], CSW: [0, 0, 0, -20000, 0] },
    } });
  });
  await broker.connected(page);
  await page.getByRole('link', { name: 'performance', exact: true }).click();
  const pnl = page.getByRole('img', { name: 'Portfolio P/L excluding cash transfers', exact: true });
  const metrics = page.getByRole('group', { name: 'Performance metric' });
  await expect(metrics.getByRole('button', { name: 'P/L', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.performance-heading h2')).toHaveText('-$250.00');
  await expect(pnl.locator('circle title')).toHaveText(/^-\$250\.00/);
  const plottedY = (await pnl.locator('.performance-series').getAttribute('points'))!.split(' ').map(point => Number(point.split(',')[1]));
  const zero = Number(await pnl.locator('.chart-zero-line').getAttribute('y1'));
  expect(plottedY).toHaveLength(5);
  expect(plottedY[0]).toBe(zero); expect(plottedY[1]).toBe(plottedY[0]); // Deposit is not a gain.
  expect(plottedY[2]).toBeLessThan(zero); expect(plottedY[3]).toBe(plottedY[2]); // Withdrawal is not a loss.
  expect(plottedY[4]).toBeGreaterThan(zero);
  await expect(pnl.locator('.performance-series')).toHaveAttribute('stroke', 'var(--negative)');
  if (standalone) await page.screenshot({ path: testInfo.outputPath('pnl-desktop.png') });
  const initialRequests = requests.length;
  await metrics.getByRole('button', { name: 'Equity', exact: true }).click();
  await expect(page.getByRole('img', { name: 'Portfolio equity', exact: true })).toBeVisible();
  await expect(page.locator('.performance-heading h2')).toHaveText('$129,750.00');
  expect(requests).toHaveLength(initialRequests);
  await metrics.getByRole('button', { name: 'P/L', exact: true }).click();
  await expect(pnl).toBeVisible(); expect(requests).toHaveLength(initialRequests);
  for (const label of ['1D', '1W', 'All time']) {
    await page.getByRole('group', { name: 'Performance period' }).getByRole('button', { name: label, exact: true }).click();
    await expect(page.locator('.performance-panel')).toHaveAttribute('aria-busy', 'false');
    await expect(pnl).toBeVisible(); await expect(page.locator('.performance-heading h2')).toHaveText('-$250.00');
  }
  expect(requests).toHaveLength(4);
  expect(requests.every(url => url.searchParams.get('cashflow_types') === 'CSD,CSW,JNLC,ACATC' && url.searchParams.get('pnl_reset') === 'no_reset')).toBe(true);
  expect(requests.at(-1)!.searchParams.has('start')).toBe(true);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await expect(pnl).toBeVisible();
  if (standalone) await page.screenshot({ path: testInfo.outputPath('pnl-mobile.png'), fullPage: true });
  expect(broker.writes).toEqual([]); expect(broker.errors).toEqual([]);
});

test('P/L stays flat for transfers alone and becomes unavailable if transfer history is incomplete', async ({ page }) => {
  const broker = new BrokerFixture(); await broker.install(page);
  let incomplete = false;
  await page.route('**/v2/account/portfolio/history?*', route => route.fulfill({ json: {
    timestamp: [0, 1, 2].map(hours => Math.floor(broker.now / 1000) - (2 - hours) * 3600),
    equity: [100000, 150000, 130000], profit_loss: [0, 50000, 30000], base_value: 100000, base_value_asof: '2026-09-16',
    cashflow: { CSD: incomplete ? [0, null, 0] : [0, 50000, 0], CSW: [0, 0, -20000] },
  } }));
  await broker.connected(page); await page.getByRole('link', { name: 'performance', exact: true }).click();
  const pnl = page.getByRole('img', { name: 'Portfolio P/L excluding cash transfers', exact: true });
  await expect(page.locator('.performance-heading h2')).toHaveText('$0.00');
  const line = (await pnl.locator('.performance-series').getAttribute('points'))!.split(' ').map(point => Number(point.split(',')[1]));
  expect(new Set(line).size).toBe(1); expect(line[0]).toBe(Number(await pnl.locator('.chart-zero-line').getAttribute('y1')));
  incomplete = true;
  await page.getByRole('group', { name: 'Performance period' }).getByRole('button', { name: '1W', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('incomplete cash transfer history');
  await expect(pnl).toHaveCount(0); await expect(page.locator('.performance-heading h2')).toHaveText('—');
  expect(broker.writes).toEqual([]); expect(broker.errors).toEqual([]);
});
