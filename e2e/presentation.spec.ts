import { test, expect } from '@playwright/test';
import { BrokerFixture } from './support/broker';

test('charts handle a single observation without losing their axes', async ({ page }) => {
  const broker = new BrokerFixture(); await broker.install(page);
  await page.route('**/v2/stocks/SPY/bars?*', route => route.fulfill({ json: { bars: [
    { t: '2026-09-17T13:30:00Z', o: 100, h: 100, l: 100, c: 100, v: 1000 },
  ], next_page_token: null } }));
  await page.route('**/v2/account/portfolio/history?*', route => route.fulfill({ json: {
    timestamp: [Math.floor(broker.now / 1000)], equity: [100000], profit_loss: [0], profit_loss_pct: [0],
  } }));
  await broker.connected(page);
  await expect(page.getByRole('region', { name: 'SPY chart', exact: true })).toContainText('Last close: $100.00');
  await page.getByRole('link', { name: 'performance', exact: true }).click();
  const chart = page.getByRole('img', { name: 'Portfolio P/L excluding cash transfers', exact: true });
  await expect(chart.locator('circle')).toBeVisible();
  await expect(chart.locator('text').filter({ hasText: '10:30' })).toBeVisible();
  expect(broker.errors).toEqual([]);
});

test('chart intervals and performance periods work with one click and preserve ticket drafts', async ({ page }) => {
  const broker = new BrokerFixture(); await broker.install(page); await broker.connected(page);
  await page.getByLabel('Quantity', { exact: true }).fill('17');
  const interval = page.getByRole('group', { name: 'Chart interval' }).getByRole('button', { name: '15m', exact: true });
  await interval.click();
  await expect(interval).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => broker.requests.some(url => url.pathname === '/v2/stocks/SPY/bars' && url.searchParams.get('timeframe') === '15Min')).toBe(true);
  await expect(page.getByRole('region', { name: 'SPY chart', exact: true })).toContainText('New York time (ET)');
  await expect(page.getByLabel('Quantity', { exact: true })).toHaveValue('17');
  await page.getByRole('link', { name: 'performance', exact: true }).click();
  const period = page.getByRole('group', { name: 'Performance period' }).getByRole('button', { name: '1W', exact: true });
  await period.click();
  await expect(period).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => broker.requests.some(url => url.pathname === '/v2/account/portfolio/history' && url.searchParams.get('period') === '1W')).toBe(true);
  await page.getByRole('group', { name: 'Performance metric' }).getByRole('button', { name: 'Equity', exact: true }).click();
  const chart = page.getByRole('img', { name: 'Portfolio equity', exact: true });
  await expect(chart).toBeVisible();
  await expect(chart).toContainText('Equity · USD');
  await expect(chart.locator('text').filter({ hasText: /\$100,/ }).first()).toBeVisible();
  await expect(chart.locator('text').filter({ hasText: '09:30' })).toBeVisible();
  expect(broker.writes).toEqual([]); expect(broker.errors).toEqual([]);
});

test('populated tables distinguish gains and losses and scroll within the phone viewport', async ({ page }) => {
  const broker = new BrokerFixture();
  broker.positions = [
    { symbol: 'SPY', qty: '24', avg_entry_price: '98', current_price: '101.2', market_value: '2428.80', unrealized_pl: '76.80', side: 'long' },
    { symbol: 'QQQ', qty: '12', avg_entry_price: '103.4', current_price: '101.2', market_value: '1214.40', unrealized_pl: '-26.40', side: 'long' },
  ];
  broker.activities = [
    { id: 'fill-1', order_id: 'order-1', activity_type: 'FILL', type: 'fill', transaction_time: '2026-09-16T14:00:00Z', symbol: 'SPY', qty: '10', price: '100', side: 'buy' },
    { id: 'fill-2', order_id: 'order-2', activity_type: 'FILL', type: 'fill', transaction_time: '2026-09-17T14:00:00Z', symbol: 'SPY', qty: '10', price: '102', side: 'sell' },
  ];
  await broker.install(page); await broker.connected(page);
  const positions = page.getByRole('region', { name: 'Positions table' });
  await expect(positions.locator('.pnl.positive')).toHaveText('+$76.80');
  await expect(positions.locator('.pnl.negative')).toHaveText('-$26.40');
  expect(await positions.locator('.pnl.positive').evaluate(node => getComputedStyle(node).color))
    .not.toBe(await positions.locator('.pnl.negative').evaluate(node => getComputedStyle(node).color));
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await positions.scrollIntoViewIfNeeded();
  await positions.evaluate(node => { node.scrollLeft = node.scrollWidth; });
  await expect(positions.getByRole('button', { name: 'Close holding' }).first()).toBeInViewport();
  await page.getByRole('link', { name: 'history', exact: true }).click();
  await expect(page.getByText('Broker activity import complete.', { exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Monthly results', exact: true }).locator('.pnl')).toHaveText('+$20.00');
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await page.setViewportSize({ width: 2560, height: 1440 });
  expect((await page.locator('.history-page').boundingBox())!.width).toBeLessThanOrEqual(1080);
  expect(broker.writes).toEqual([]); expect(broker.errors).toEqual([]);
});
