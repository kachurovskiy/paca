import { test, expect } from '@playwright/test';
import { BrokerFixture } from './support/broker';

for (const standalone of [false, true]) for (const environment of ['paper', 'live']) {
  test(`${standalone ? 'standalone build' : 'development'} reconnects ${environment} automatically on reload and reopening until keys are forgotten`, async ({ page, context }) => {
    const broker = new BrokerFixture(); await broker.install(page, standalone); await broker.connect(page, environment); await broker.ready(page, environment);
    if (environment === 'live') {
      await page.getByLabel('Arm live manual trading for this session').check();
      await page.getByRole('link', { name: 'robots', exact: true }).click();
      await page.getByLabel('Enable live Robot entries for this connection').check();
      await page.getByRole('link', { name: 'terminal', exact: true }).click();
    }
    await page.reload(); await broker.ready(page, environment);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    if (environment === 'live') {
      await expect(page.getByLabel('Arm live manual trading for this session')).not.toBeChecked();
      await expect(page.locator('.submit-order')).toBeDisabled();
      await page.getByRole('link', { name: 'robots', exact: true }).click();
      await expect(page.getByLabel('Enable live Robot entries for this connection')).not.toBeChecked();
    }
    await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
    await page.getByRole('link', { name: 'history', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Your trading workspace' })).toBeVisible();
    await expect(page.locator('.mode-badge')).toHaveText('Disconnected');
    await page.close();

    const reopened = await context.newPage(); await broker.install(reopened, standalone);
    await broker.ready(reopened, environment);
    await expect(reopened.getByRole('dialog')).toHaveCount(0);
    await expect(reopened.locator('header .stats-grid')).toContainText('$100,000.00');
    expect(broker.socketUrls).toHaveLength(3);
    await reopened.getByRole('button', { name: 'Disconnect', exact: true }).click();
    await reopened.getByRole('button', { name: 'Connect Alpaca', exact: true }).click();
    await expect(reopened.getByLabel('API key', { exact: true })).toHaveValue('synthetic-key');
    await expect(reopened.getByLabel('Secret key', { exact: true })).toHaveValue('synthetic-secret');
    await expect(reopened.getByLabel('Secret key', { exact: true })).toHaveAttribute('type', 'password');
    await expect(reopened.getByRole('group', { name: 'Environment' }).getByRole('button', { name: environment === 'live' ? 'Live' : 'Paper', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await reopened.getByRole('button', { name: 'Forget saved keys' }).click();
    await expect(reopened.getByLabel('API key', { exact: true })).toHaveValue('');
    await expect(reopened.getByLabel('Secret key', { exact: true })).toHaveValue('');
    await reopened.reload();
    await expect(reopened.locator('.mode-badge')).toHaveText('Disconnected');
    await reopened.getByRole('button', { name: 'Connect Alpaca', exact: true }).click();
    await expect(reopened.getByLabel('API key', { exact: true })).toHaveValue('');
    await expect(reopened.getByLabel('Secret key', { exact: true })).toHaveValue('');
    await expect(reopened.getByRole('group', { name: 'Environment' }).getByRole('button', { name: 'Paper', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(reopened.getByRole('button', { name: 'Forget saved keys' })).toHaveCount(0);
    expect(broker.socketUrls).toHaveLength(3);
    expect(broker.writes).toEqual([]); expect(broker.errors).toEqual([]);
  });
}

for (const standalone of [false, true]) {
  test(`${standalone ? 'standalone' : 'development'} failed automatic authentication opens editable credentials for an explicit retry`, async ({ page }) => {
    const broker = new BrokerFixture(); await broker.install(page, standalone); await broker.connected(page);
    let attempts = 0;
    await page.route('**/v2/account', route => { attempts++; return route.fulfill({ status: 401, json: { message: 'Invalid credentials' } }); });
    await page.reload();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('alert')).toContainText('Authentication failed');
    await expect(dialog.getByLabel('API key', { exact: true })).toHaveValue('synthetic-key');
    await expect(dialog.getByLabel('Secret key', { exact: true })).toBeEnabled();
    await dialog.getByLabel('Secret key', { exact: true }).fill('replacement-synthetic-secret');
    expect(attempts).toBe(1);
    await page.unroute('**/v2/account');
    await dialog.getByRole('button', { name: 'Connect account', exact: true }).click();
    await broker.ready(page); await expect(dialog).toHaveCount(0);
    expect(broker.writes).toEqual([]); expect(broker.errors).toEqual([]);
  });

  test(`${standalone ? 'standalone' : 'development'} automatic connection can be canceled without a late response reconnecting`, async ({ page }) => {
    const broker = new BrokerFixture(); await broker.install(page, standalone); await broker.connected(page);
    let release!: () => void, started = false, finished = false;
    const pending = new Promise<void>(resolve => { release = resolve; });
    await page.route('**/v2/account', async route => { started = true; await pending; await route.fallback(); finished = true; });
    try {
      await page.reload(); await expect.poll(() => started).toBe(true);
      await expect(page.getByRole('status')).toContainText('Reconnecting to your saved paper account');
      await expect(page.getByRole('button', { name: 'Connecting…', exact: true })).toBeDisabled();
      await page.getByRole('button', { name: 'Cancel connection', exact: true }).click();
      release(); await expect.poll(() => finished).toBe(true);
      await expect(page.locator('.mode-badge')).toHaveText('Disconnected');
      await expect(page.getByRole('dialog')).toHaveCount(0);
      expect(broker.socketUrls).toHaveLength(1);
      await page.unroute('**/v2/account');
      await broker.connected(page);
      expect(broker.socketUrls).toHaveLength(2);
      expect(broker.writes).toEqual([]); expect(broker.errors).toEqual([]);
    } finally { release(); }
  });
}

test('unavailable credential storage reports the problem without preventing connection', async ({ page }) => {
  await page.addInitScript(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === 'paca.current.credentials') throw new DOMException('Storage unavailable', 'QuotaExceededError');
      original.call(this, key, value);
    };
  });
  const broker = new BrokerFixture(); await broker.install(page); await broker.connected(page);
  await expect(page.getByRole('alert')).toContainText('Keys could not be saved');
  await page.reload();
  await page.getByRole('button', { name: 'Connect Alpaca', exact: true }).click();
  await expect(page.getByLabel('API key', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('Secret key', { exact: true })).toHaveValue('');
  expect(broker.errors).toEqual([]);
});

test('corrupt saved credentials leave the connection form usable', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('paca.current.credentials', '{"keyId":42,"secretKey":null,"environment":"live"}'));
  const broker = new BrokerFixture(); await broker.install(page);
  await page.getByRole('button', { name: 'Connect Alpaca', exact: true }).click();
  await expect(page.getByLabel('API key', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('Secret key', { exact: true })).toHaveValue('');
  await expect(page.getByRole('group', { name: 'Environment' }).getByRole('button', { name: 'Paper', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await broker.connected(page); expect(broker.errors).toEqual([]);
});
