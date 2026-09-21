import { test, expect } from '@playwright/test';
import { BrokerFixture, stored } from './support/broker';

for (const standalone of [false, true]) {
  test(`${standalone ? 'standalone' : 'development'} manual orders fill, cancel and release capital automatically`, async ({ page }) => {
    const broker = new BrokerFixture(true); broker.buyingPower = 1000;
    await broker.install(page, standalone); await broker.connected(page);
    const ticket = page.locator('.order-ticket'), status = ticket.getByRole('status');
    await ticket.getByRole('group', { name: 'Order type', exact: true }).getByRole('button', { name: 'Limit', exact: true }).click();
    await ticket.getByLabel('Limit price').fill('101');
    await ticket.getByLabel('Quantity', { exact: true }).fill('6');
    await ticket.getByRole('button', { name: 'Buy SPY', exact: true }).click();
    await expect(status).toContainText('Order acknowledged');
    await expect.poll(async () => (await stored(page, 'manualCommands'))[0].status).toBe('acknowledged');

    const order = broker.orders[0];
    Object.assign(order, { filled_qty: '2', filled_avg_price: '101', status: 'partially_filled' });
    broker.positions = [{ symbol: 'SPY', qty: '2', avg_entry_price: '101', side: 'long' }];
    await broker.advance(page, 5000);
    await expect(status).toContainText('Order partially filled. Filled 2 of 6 shares.');
    await expect(page.getByRole('row').filter({ hasText: 'External / manual' })).toContainText('2');
    await expect.poll(async () => (await stored(page, 'manualCommands'))[0].commitmentCents).toBe(40400);

    Object.assign(order, { filled_qty: '6', status: 'filled' });
    broker.positions[0].qty = '6'; broker.buyingPower = 700;
    await broker.advance(page, 5000);
    await expect(status).toContainText('Order filled. Filled 6 of 6 shares.');
    await expect(page.getByRole('row').filter({ hasText: 'External / manual' })).toContainText('6');
    await expect.poll(async () => (await stored(page, 'manualCommands'))[0].commitmentCents).toBe(0);

    await ticket.getByRole('button', { name: 'New order', exact: true }).click();
    await ticket.getByRole('button', { name: 'Buy SPY', exact: true }).click();
    await expect(status).toContainText('Order acknowledged');
    await expect.poll(() => broker.orders.length).toBe(2);
    broker.deferCancellation = true;
    await page.getByRole('button', { name: /^Orders \(/ }).click();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect.poll(async () => (await stored(page, 'manualCommands')).find(command => (command.action as { kind: string }).kind === 'cancel')?.status).toBe('acknowledged');
    await broker.advance(page, 5000);
    await expect(status).toContainText('Order pending cancel');
    expect((await stored(page, 'manualCommands')).filter(command => command.status === 'resolved')).toHaveLength(1);

    broker.orders[1].status = 'canceled';
    await broker.advance(page, 5000);
    await expect(status).toContainText('Order canceled. Filled 0 of 6 shares.');
    await expect(page.getByRole('button', { name: 'Orders (0)', exact: true })).toBeVisible();
    await expect.poll(async () => (await stored(page, 'manualCommands')).every(command => command.status === 'resolved' && command.commitmentCents === 0)).toBe(true);
    await ticket.getByRole('button', { name: 'New order', exact: true }).click();
    await ticket.getByRole('button', { name: 'Buy SPY', exact: true }).click();
    await expect(status).toContainText('Order acknowledged');
    expect(broker.writes.filter(write => write.method === 'POST')).toHaveLength(3);
    expect(broker.writes.filter(write => write.method === 'DELETE')).toHaveLength(1);
    expect(broker.errors).toEqual([]);
  });

  test(`${standalone ? 'standalone' : 'development'} submitted ticket stays tied to its order until New order`, async ({ page }) => {
    const broker = new BrokerFixture();
    broker.positions = [{ symbol: 'QQQ', qty: '3', avg_entry_price: '100', side: 'long' }];
    await broker.install(page, standalone); await broker.connect(page, 'live');
    await page.getByLabel('Arm live manual trading for this session').check();
    await page.getByLabel('Quantity', { exact: true }).fill('3');
    await page.getByRole('button', { name: 'Buy SPY', exact: true }).click();
    const ticket = page.locator('.order-ticket'), status = ticket.getByRole('status');
    await expect(status).toContainText('Buy 3 SPY · market. Order acknowledged');
    const originalId = broker.writes[0].body!.client_order_id;

    await page.getByLabel('Chart ticker').fill('QQQ');
    await page.getByRole('button', { name: 'Go to ticker' }).click();
    await expect(page.getByRole('region', { name: 'QQQ chart' })).toBeVisible();
    await expect(ticket.getByRole('heading')).toHaveText('Trade SPY');
    for (const name of ['Order side', 'Order type']) for (const button of await ticket.getByRole('group', { name, exact: true }).getByRole('button').all()) await expect(button).toBeDisabled();
    await expect(ticket.getByLabel('Quantity', { exact: true })).toBeDisabled();
    await expect(ticket.locator('.submit-order')).toBeDisabled();
    await expect(status).toContainText('Buy 3 SPY · market. Order acknowledged');
    await ticket.locator('form').evaluate((form: HTMLFormElement) => form.requestSubmit());
    expect(broker.writes).toHaveLength(1);

    await ticket.getByRole('button', { name: 'New order', exact: true }).click();
    await expect(status).toHaveCount(0);
    await expect(ticket.getByRole('heading')).toHaveText('Trade QQQ');
    await ticket.getByRole('group', { name: 'Order side', exact: true }).getByRole('button', { name: 'Sell holdings', exact: true }).click();
    await ticket.getByLabel('Quantity', { exact: true }).fill('2');
    await ticket.getByRole('group', { name: 'Order type', exact: true }).getByRole('button', { name: 'Limit', exact: true }).click();
    await ticket.getByLabel('Limit price').fill('101.19');
    await ticket.getByRole('button', { name: 'Sell QQQ', exact: true }).click();
    await expect(status).toContainText('Sell 2 QQQ · limit at $101.19. Order acknowledged');
    await expect(ticket.getByLabel('Limit price')).toBeDisabled();
    expect(broker.writes).toHaveLength(2);
    expect(broker.writes[1].body).toMatchObject({ symbol: 'QQQ', side: 'sell', qty: '2', type: 'limit', limit_price: '101.19' });
    expect(broker.writes[1].body!.client_order_id).not.toBe(originalId);
    expect(await stored(page, 'manualCommands')).toHaveLength(2);
    expect(broker.errors).toEqual([]);
  });
}

test('a delayed acknowledgement retains the submitted symbol and blocks concurrent submission', async ({ page }) => {
  const broker = new BrokerFixture(); await broker.install(page); await broker.connected(page);
  let release!: () => void;
  const response = new Promise<void>(resolve => { release = resolve; });
  broker.beforeWrite = () => response;
  const ticket = page.locator('.order-ticket');
  try {
    await ticket.locator('form').evaluate((form: HTMLFormElement) => { form.requestSubmit(); form.requestSubmit(); });
    await expect.poll(() => broker.writes.length).toBe(1);
    await expect(ticket.getByLabel('Quantity', { exact: true })).toBeDisabled();
    await expect(ticket.locator('.submit-order')).toBeDisabled();
    await page.getByLabel('Chart ticker').fill('QQQ');
    await page.getByRole('button', { name: 'Go to ticker' }).click();
    await expect(ticket.getByRole('heading')).toHaveText('Trade SPY');
    await expect(ticket.getByRole('button', { name: 'New order', exact: true })).toHaveCount(0);
  } finally { release(); }
  await expect(ticket.getByRole('status')).toContainText('Buy 1 SPY · market. Order acknowledged');
  expect(broker.writes).toHaveLength(1);
  expect(broker.errors).toEqual([]);
});

test('New order preserves the execution hold after an uncertain response', async ({ page }) => {
  const broker = new BrokerFixture(); await broker.install(page); await broker.connected(page);
  broker.loseNextResponse = true; broker.hideOrders = true;
  const ticket = page.locator('.order-ticket');
  await ticket.getByRole('button', { name: 'Buy SPY', exact: true }).click();
  await expect(ticket.getByRole('status')).toContainText('Buy 1 SPY · market. uncertain:');
  await expect(ticket.locator('.submit-order')).toBeDisabled();
  await page.getByLabel('Chart ticker').fill('QQQ');
  await page.getByRole('button', { name: 'Go to ticker' }).click();
  await ticket.getByRole('button', { name: 'New order', exact: true }).click();
  await ticket.getByRole('button', { name: 'Buy QQQ', exact: true }).click();
  await expect(ticket.getByRole('status')).toContainText('Buy QQQ: Reconcile uncertain commands');
  expect(broker.writes).toHaveLength(1);
  expect(broker.errors).toEqual([]);
});
