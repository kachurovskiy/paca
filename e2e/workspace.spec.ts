import { test, expect } from '@playwright/test';
import { BrokerFixture, MINUTE, OPEN, stored, watchlistRequest } from './support/broker';

for (const standalone of [false, true]) {
  test(`${standalone ? 'standalone build' : 'development'} connects, charts, trades, cancels and exports history`, async ({ page }) => {
    const broker = new BrokerFixture(); await broker.install(page, standalone);
    await expect(page.locator('.mode-badge')).toHaveText('Disconnected');
    await expect(page.locator('.stats-grid')).toHaveCount(0);
    await broker.connected(page);
    expect(broker.socketUrls).toEqual(['wss://stream.data.alpaca.markets/v2/sip']);
    expect(broker.requests.filter(url => url.searchParams.has('feed') && !watchlistRequest(url, broker.now)).every(url => url.searchParams.get('feed') === 'sip')).toBe(true);
    await expect(page.getByRole('region', { name: 'SPY chart' })).toBeVisible();
    await page.getByLabel('Quantity', { exact: true }).fill('3');
    broker.beforeWrite = async () => { const commands = await stored(page, 'manualCommands'); expect(commands).toHaveLength(1); expect(commands[0].status).toBe('pending'); };
    await page.getByRole('button', { name: 'Buy SPY', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Order acknowledged');
    broker.beforeWrite = undefined;
    expect(broker.writes[0].body).toMatchObject({ symbol: 'SPY', side: 'buy', qty: '3', type: 'market' });
    await expect(page.getByRole('button', { name: 'Buy SPY', exact: true })).toBeDisabled();
    await expect(page.getByRole('status')).toContainText('Buy 3 SPY · market. Order acknowledged'); expect(broker.writes).toHaveLength(1);
    await page.getByRole('button', { name: 'Orders (1)', exact: true }).click();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect.poll(() => broker.writes.length).toBe(2);
    await page.getByLabel('Add ticker').fill('STEADY'); await page.getByRole('button', { name: 'Add symbol' }).click();
    await expect(page.getByRole('button', { name: 'Remove STEADY' })).toBeVisible();
    await page.getByRole('link', { name: 'performance', exact: true }).click();
    await expect(page.getByRole('img', { name: 'Portfolio equity' })).toBeVisible();
    await page.getByRole('link', { name: 'history', exact: true }).click();
    await expect(page.getByText('Broker activity import complete.')).toBeVisible();
    const download = page.waitForEvent('download'); await page.getByRole('button', { name: 'Export history' }).click();
    expect((await download).suggestedFilename()).toBe('paca-history.json');
    await page.getByRole('link', { name: 'scanner', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Broad scanner' })).toBeVisible();
    await page.getByRole('link', { name: 'robots', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Paper Robots' })).toBeVisible();
    await page.getByRole('button', { name: 'forecasts', exact: true }).click(); await expect(page.getByText('No current-version offers have been retained. Forecast evidence is unavailable.')).toBeVisible();
    await page.reload(); await broker.ready(page);
    await page.getByRole('link', { name: 'terminal', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Show STEADY chart', exact: true })).toBeVisible();
    expect(broker.errors).toEqual([]);
  });
}

test('drafts, focus, caret and mounted chart survive quote and account refreshes', async ({ page }) => {
  const broker = new BrokerFixture(true); await broker.install(page); await broker.connected(page);
  await page.getByRole('group', { name: 'Order type', exact: true }).getByRole('button', { name: 'Limit', exact: true }).click(); await page.getByLabel('Limit price').fill('100.12');
  const quantity = page.getByLabel('Quantity', { exact: true }); await quantity.fill('12345');
  await quantity.evaluate((input: HTMLInputElement) => { input.focus(); input.setSelectionRange(2, 2); });
  const canvas = await page.locator('canvas').elementHandle();
  for (let i = 0; i < 20; i++) await broker.advance(page, 1000);
  await expect(quantity).toHaveValue('12345'); await expect(quantity).toBeFocused();
  expect(await quantity.evaluate((input: HTMLInputElement) => input.selectionStart)).toBe(2);
  await expect(page.getByLabel('Limit price')).toHaveValue('100.12');
  expect(await canvas!.evaluate(node => node === document.querySelector('canvas'))).toBe(true);
  expect(await page.evaluate(() => (window as unknown as { fixtureChartInstances: number }).fixtureChartInstances)).toBe(1);
  expect(broker.errors).toEqual([]);
});

test('a late chart response cannot replace the newly selected symbol', async ({ page }) => {
  const broker = new BrokerFixture(); broker.delayChart = { symbol: 'SPY', release: null };
  await broker.install(page); await broker.connected(page);
  await expect.poll(() => !!broker.delayChart?.release).toBe(true);
  await page.getByLabel('Chart ticker').fill('QQQ'); await page.getByRole('button', { name: 'Go to ticker' }).click();
  await expect(page.getByRole('region', { name: 'QQQ chart' })).toContainText('Last close: $222.00');
  broker.delayChart!.release!(); await page.waitForTimeout(100);
  await expect(page.getByRole('region', { name: 'QQQ chart' })).toContainText('Last close: $222.00');
  expect(broker.errors).toEqual([]);
});

test('lost order response remains durable across reload and is never replayed', async ({ page }) => {
  const broker = new BrokerFixture(); await broker.install(page); await broker.connected(page);
  broker.loseNextResponse = true; broker.hideOrders = true;
  await page.getByRole('button', { name: 'Buy SPY', exact: true }).click();
  await expect(page.locator('.order-ticket')).toContainText('uncertain');
  expect((await stored(page, 'manualCommands'))[0].status).toBe('uncertain');
  await page.reload(); await broker.ready(page);
  await page.getByRole('button', { name: 'Buy SPY', exact: true }).click();
  await expect(page.locator('.order-ticket')).toContainText(/uncertain|unresolved/i);
  expect(broker.writes).toHaveLength(1);
  broker.hideOrders = false; await page.getByRole('button', { name: 'Reconcile account', exact: true }).click();
  await expect.poll(async () => (await stored(page, 'manualCommands'))[0].status).toBe('acknowledged');
  expect(broker.writes).toHaveLength(1); expect(broker.errors).toEqual([]);
});

test('live manual arming is explicit and resets after reconnect', async ({ page }) => {
  const broker = new BrokerFixture(); await broker.install(page); await broker.connect(page, 'live');
  await expect(page.locator('.mode-badge')).toHaveText('Live'); await expect(page.locator('.submit-order')).toBeDisabled();
  await page.getByLabel('Arm live manual trading for this session').check(); await expect(page.locator('.submit-order')).toBeEnabled();
  await page.getByRole('button', { name: 'Buy SPY', exact: true }).click(); await expect.poll(() => broker.writes.length).toBe(1);
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click(); await broker.connect(page, 'live');
  await expect(page.locator('.mode-badge')).toHaveText('Live'); await expect(page.getByLabel('Arm live manual trading for this session')).not.toBeChecked();
  await expect(page.locator('.submit-order')).toBeDisabled(); expect(broker.errors).toEqual([]);
});

test('actual Web Lock spans navigation and requires explicit reconnection in another tab', async ({ page, context }) => {
  const broker = new BrokerFixture(); await broker.install(page); await broker.connected(page);
  await page.getByRole('link', { name: 'history', exact: true }).click();
  const other = await context.newPage(); await broker.install(other);
  await expect(other.getByRole('alert')).toContainText(/another tab/i);
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await expect(other.locator('.mode-badge')).toHaveText('Disconnected');
  await other.getByRole('button', { name: 'Connect account', exact: true }).last().click();
  await expect(other.locator('.mode-badge')).toHaveText('Paper'); expect(broker.writes).toEqual([]); expect(broker.errors).toEqual([]);
});

test('history failure remains local while manual execution is available', async ({ page }) => {
  const broker = new BrokerFixture(); await broker.install(page); await broker.connected(page); broker.badHistory = true;
  await page.getByRole('link', { name: 'history', exact: true }).click(); await expect(page.getByText(/Trade history import is incomplete/)).toBeVisible();
  await page.getByRole('link', { name: 'terminal', exact: true }).click();
  await page.getByRole('button', { name: 'Buy SPY', exact: true }).click(); await expect(page.locator('.order-ticket')).toContainText('Order acknowledged');
  expect(broker.writes).toHaveLength(1); expect(broker.errors).toEqual([]);
});

test('phone layout keeps connected screens within the viewport', async ({ page }) => {
  const broker = new BrokerFixture(); await broker.install(page); await broker.connected(page);
  await page.setViewportSize({ width: 390, height: 844 });
  for (const name of ['terminal', 'scanner', 'robots', 'performance', 'history']) {
    await page.getByRole('link', { name, exact: true }).click();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(391);
  }
  expect(broker.errors).toEqual([]);
});

test('disconnect fences a sent order and holds ownership until its durable result settles', async ({ page, context }) => {
  const broker = new BrokerFixture(); await broker.install(page); await broker.connected(page);
  let release!: () => void;
  broker.beforeWrite = () => new Promise<void>(resolve => { release = resolve; });
  await page.getByRole('button', { name: 'Buy SPY', exact: true }).click();
  await expect.poll(() => !!release).toBe(true);
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
  const other = await context.newPage(); await broker.install(other);
  await expect(other.getByRole('alert')).toContainText(/another tab/i);
  release();
  await expect.poll(async () => (await stored(page, 'manualCommands'))[0].status).toBe('acknowledged');
  await other.getByRole('button', { name: 'Connect account', exact: true }).last().click();
  await expect(other.locator('.mode-badge')).toHaveText('Paper');
  expect(broker.writes).toHaveLength(1); expect(broker.errors).toEqual([]);
});

test('limit defaults use executable-side prices and closing prefills the exact fractional holding', async ({ page }) => {
  const broker = new BrokerFixture();
  broker.positions = [{ symbol: 'QQQ', qty: '1.234567891', avg_entry_price: '100', current_price: '101.2', market_value: '124.93', unrealized_pl: '1.48', unrealized_plpc: '.012', side: 'long' }];
  await broker.install(page); await broker.connected(page);
  await page.getByRole('group', { name: 'Order type', exact: true }).getByRole('button', { name: 'Limit', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Auto limit', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Limit price')).toHaveValue('101.21');
  await page.getByLabel('Quantity', { exact: true }).fill('49');
  await page.getByRole('button', { name: 'Buy SPY', exact: true }).click();
  await expect(page.locator('.order-ticket')).toContainText('Order acknowledged');
  expect(broker.writes[0].body).toMatchObject({ type: 'limit', qty: '49', limit_price: '101.21', time_in_force: 'day', extended_hours: false });
  await expect(page.locator('.order-ticket').getByRole('status')).toContainText('Buy 49 SPY · limit at $101.21. Order acknowledged');
  await expect(page.getByLabel('Quantity', { exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Close holding', exact: true }).click();
  expect(broker.writes).toHaveLength(1);
  await expect(page.locator('.order-ticket')).toContainText('1.234567891');
  await page.getByRole('button', { name: 'Sell QQQ', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Confirm order', exact: true })).toContainText('entire holding');
  await page.getByRole('button', { name: 'Confirm sell QQQ', exact: true }).click();
  await expect.poll(() => broker.writes.length).toBe(2);
  expect(broker.writes[1].body).toMatchObject({ symbol: 'QQQ', type: 'limit', side: 'sell', qty: '1.234567891', limit_price: '101.19' });
  expect(broker.errors).toEqual([]);
});

for (const minutesBeforeOpen of [60, 300]) {
  test(`outside regular hours (${minutesBeforeOpen} minutes before open) market orders block and limits remain available`, async ({ page }) => {
    const broker = new BrokerFixture(); broker.now = OPEN - minutesBeforeOpen * MINUTE;
    await broker.install(page); await broker.connected(page);
    await expect(page.getByRole('button', { name: 'Buy SPY', exact: true })).toBeDisabled();
    await expect(page.locator('.order-ticket')).toContainText('selected trading session is closed'); expect(broker.writes).toEqual([]);
    await page.getByRole('group', { name: 'Order type', exact: true }).getByRole('button', { name: 'Limit', exact: true }).click(); await page.getByLabel('Limit price').fill('100.25');
    await expect(page.getByRole('button', { name: 'Buy SPY', exact: true })).toBeDisabled();
    await page.getByRole('group', { name: 'Trading sessions', exact: true }).getByRole('button', { name: '+ Extended', exact: true }).click();
    await page.getByRole('button', { name: 'Buy SPY', exact: true }).click(); await expect(page.locator('.order-ticket')).toContainText('Order acknowledged');
    expect(broker.writes[0].body).toMatchObject({ type: 'limit', limit_price: '100.25', extended_hours: true });
    expect(broker.errors).toEqual([]);
  });
}

test('corrupt research stays local while corrupt execution fails closed without resetting evidence', async ({ page }) => {
  const broker = new BrokerFixture(); await broker.install(page); await broker.connected(page);
  const scope = JSON.stringify(['alpaca', 'paper', broker.accountId]);
  await page.evaluate(scope => new Promise<void>((resolve, reject) => {
    const request = indexedDB.open('paca-session-snapshots', 1);
    request.onsuccess = () => { const db = request.result, tx = db.transaction('research', 'readwrite');
      tx.objectStore('research').put({ key: JSON.stringify([scope, 'broken']), scope, kind: 'proposal', proposal: null });
      tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => reject(tx.error); };
  }), scope);
  await page.getByRole('link', { name: 'robots', exact: true }).click();
  await expect(page.getByText('Unsupported research document.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Reconcile runs', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Command completed' })).toBeVisible();
  await page.getByRole('link', { name: 'terminal', exact: true }).click(); await page.getByRole('button', { name: 'Buy SPY', exact: true }).click();
  await expect(page.locator('.order-ticket')).toContainText('Order acknowledged');
  await page.evaluate(scope => new Promise<void>((resolve, reject) => {
    const request = indexedDB.open('paca-session-snapshots', 1);
    request.onsuccess = () => { const db = request.result, tx = db.transaction('manualCommands', 'readwrite'), store = tx.objectStore('manualCommands'), read = store.getAll();
      read.onsuccess = () => store.put({ ...read.result[0], scope, status: 'corrupted' });
      tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => reject(tx.error); };
  }), scope);
  await page.reload(); await broker.ready(page);
  await expect(page.locator('.notice')).toBeVisible(); await expect(page.locator('.submit-order')).toBeDisabled();
  expect((await stored(page, 'manualCommands'))[0].status).toBe('corrupted'); expect(broker.writes).toHaveLength(1); expect(broker.errors).toEqual([]);
});

test('overnight-to-daytime routing reauthenticates and keeps the ticket draft', async ({ page }) => {
  const broker = new BrokerFixture(true); broker.now = Date.parse('2026-09-17T07:59:59Z');
  await broker.install(page); await broker.connected(page);
  await expect(page.locator('.stats-grid')).toContainText('boats');
  await page.getByRole('group', { name: 'Order type', exact: true }).getByRole('button', { name: 'Limit', exact: true }).click(); await page.getByLabel('Limit price').fill('100.25');
  await page.getByLabel('Quantity', { exact: true }).fill('7');
  await page.getByRole('group', { name: 'Trading sessions', exact: true }).getByRole('button', { name: '+ Extended', exact: true }).click();
  for (let i = 0; i < 20; i++) await broker.advance(page, 1000);
  await expect(page.locator('.stats-grid')).toContainText('sip');
  // Native socket acknowledgments can arrive after the last virtual animation frame.
  for (let i = 0; i < 40 && !await page.locator('.submit-order').isEnabled(); i++) await broker.advance(page, 250);
  await expect(page.locator('.submit-order')).toBeEnabled();
  await expect(page.getByLabel('Quantity', { exact: true })).toHaveValue('7');
  expect(broker.socketUrls).toEqual(['wss://stream.data.alpaca.markets/v1beta1/boats', 'wss://stream.data.alpaca.markets/v2/sip']);
  await page.getByRole('button', { name: 'Buy SPY', exact: true }).click(); await expect(page.locator('.order-ticket')).toContainText('Order acknowledged');
  expect(broker.writes[0].body).toMatchObject({ qty: '7', limit_price: '100.25', extended_hours: true });
  expect(broker.errors).toEqual([]);
});
