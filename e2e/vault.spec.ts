import { test, expect } from '@playwright/test';
import { BrokerFixture, PASSWORD, rawStored, saveRaw, stored, unlock } from './support/broker';

for (const standalone of [false, true]) {
  test(`${standalone ? 'standalone' : 'development'} password gates all app access and decrypts saved credentials and records`, async ({ page, context }) => {
    const broker = new BrokerFixture(); await broker.install(page, standalone, true);
    await expect(page.getByRole('heading', { name: 'Protect your workspace' })).toBeVisible();
    await expect(page.getByRole('navigation')).toHaveCount(0);
    expect(broker.requests).toEqual([]); expect(broker.socketUrls).toEqual([]);
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
    await page.getByLabel('Confirm password', { exact: true }).fill('mismatched password');
    await page.getByRole('button', { name: 'Create password', exact: true }).click();
    await expect(page.getByRole('alert')).toHaveText('Passwords do not match.');
    expect(await page.evaluate(() => localStorage.getItem('paca.vault.1'))).toBeNull();
    await unlock(page); await broker.connected(page);
    await page.getByLabel('Add ticker').fill('STEADY'); await page.getByRole('button', { name: 'Add symbol' }).click();
    await page.getByRole('button', { name: 'Buy SPY', exact: true }).click();
    await expect(page.locator('.order-ticket')).toContainText('Order acknowledged');
    const records = await stored(page, 'manualCommands'); expect(records).toHaveLength(1);
    const disk = JSON.stringify(await rawStored(page, 'manualCommands')) + await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
    for (const secret of [PASSWORD, 'synthetic-key', 'synthetic-secret', broker.accountId, 'STEADY', 'SPY']) expect(disk).not.toContain(secret);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Unlock your workspace' })).toBeVisible();
    const requests = broker.requests.length, sockets = broker.socketUrls.length;
    await page.getByLabel('Password', { exact: true }).fill('incorrect password');
    await page.getByRole('button', { name: 'Unlock', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('password is incorrect');
    expect(broker.requests).toHaveLength(requests); expect(broker.socketUrls).toHaveLength(sockets);
    await expect(page.getByRole('navigation')).toHaveCount(0);
    await unlock(page); await broker.ready(page);
    await expect(page.getByRole('button', { name: 'Show STEADY chart', exact: true })).toBeVisible();
    expect((await stored(page, 'manualCommands'))[0].id).toBe(records[0].id);
    const other = await context.newPage(); await broker.install(other, standalone, true);
    await expect(other.getByRole('heading', { name: 'Unlock your workspace' })).toBeVisible();
    await expect(other.getByRole('navigation')).toHaveCount(0); await other.close();
    await page.getByRole('button', { name: 'Lock app', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Unlock your workspace' })).toBeVisible();
    await expect(page.getByLabel('Password', { exact: true })).toHaveValue('');
    await unlock(page); await broker.ready(page);
    expect(broker.writes).toHaveLength(1); expect(broker.errors).toEqual([]);
  });
}

test('tampered encrypted execution records block trading and retain the ciphertext', async ({ page }) => {
  const broker = new BrokerFixture(); await broker.install(page); await broker.connected(page);
  await page.getByRole('button', { name: 'Buy SPY', exact: true }).click();
  await expect(page.locator('.order-ticket')).toContainText('Order acknowledged');
  const [row] = await rawStored(page, 'manualCommands');
  const damaged = { ...row, ciphertext: (row.ciphertext[0] === 'A' ? 'B' : 'A') + row.ciphertext.slice(1) };
  await saveRaw(page, 'manualCommands', damaged);
  await page.reload(); await unlock(page); await broker.ready(page);
  await expect(page.locator('.notice')).toContainText('could not be authenticated');
  await expect(page.locator('.submit-order')).toBeDisabled();
  expect(await rawStored(page, 'manualCommands')).toEqual([damaged]);
  expect(broker.writes).toHaveLength(1); expect(broker.errors).toEqual([]);
});

test('unavailable storage prevents password setup and any broker access', async ({ page }) => {
  await page.addInitScript(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === 'paca.vault.1') throw new DOMException('Storage unavailable', 'QuotaExceededError');
      original.call(this, key, value);
    };
  });
  const broker = new BrokerFixture(); await broker.install(page, false, true);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Confirm password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Create password', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Storage unavailable');
  await expect(page.getByRole('navigation')).toHaveCount(0);
  expect(broker.requests).toEqual([]); expect(broker.socketUrls).toEqual([]);
});

test('damaged encrypted preferences cannot silently reset or unlock the app', async ({ page }) => {
  const broker = new BrokerFixture(); await broker.install(page); await broker.connected(page);
  await page.evaluate(() => localStorage.setItem('paca.vault.1.credentials', '{}'));
  await page.reload();
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Unlock', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('could not be authenticated');
  await expect(page.getByRole('navigation')).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('paca.vault.1.credentials'))).toBe('{}');
  expect(broker.socketUrls).toHaveLength(1); expect(broker.errors).toEqual([]);
});
