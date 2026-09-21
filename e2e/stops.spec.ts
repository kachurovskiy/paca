import { test, expect } from '@playwright/test';
import { BrokerFixture, stored } from './support/broker';

test('Limit uses latest price without an ask, follows new quotes until edited, and replaces Auto limit', async ({ page }) => {
  const broker = new BrokerFixture(); broker.bid = broker.ask = 0;
  await broker.install(page); await broker.connected(page);
  const ticket = page.locator('.order-ticket'), limit = ticket.getByLabel('Limit price', { exact: true });
  await expect(ticket.getByRole('button', { name: 'Auto limit', exact: true })).toHaveCount(0);
  await ticket.getByRole('button', { name: 'Limit', exact: true }).click();
  await expect(limit).toHaveValue('101.2');
  broker.bid = 102; broker.ask = 102.345; await broker.advance(page, 1000);
  await expect(limit).toHaveValue('102.35');
  await limit.fill('99.25'); broker.ask = 103; await broker.advance(page, 1000);
  await expect(limit).toHaveValue('99.25');
  await ticket.getByRole('button', { name: 'Buy SPY', exact: true }).click();
  await expect(ticket.getByRole('status')).toContainText('Order acknowledged');
  expect(broker.writes[0].body).toMatchObject({ type: 'limit', limit_price: '99.25' });
  expect(broker.errors).toEqual([]);
});

for (const standalone of [false, true]) {
  test(`${standalone ? 'standalone GTC market' : 'development DAY limit'} buy attaches a stop and keeps it visible and cancelable after reload`, async ({ page }) => {
    const broker = new BrokerFixture(); await broker.install(page, standalone); await broker.connected(page);
    const ticket = page.locator('.order-ticket');
    if (!standalone) {
      await ticket.getByRole('button', { name: 'Limit', exact: true }).click();
      await ticket.getByRole('group', { name: 'Trading sessions', exact: true }).getByRole('button', { name: '+ Extended', exact: true }).click();
    } else await ticket.getByRole('group', { name: 'Duration', exact: true }).getByRole('button', { name: 'GTC', exact: true }).click();
    await ticket.getByLabel('Quantity', { exact: true }).fill('2');
    await ticket.getByLabel('Add stop loss', { exact: true }).check();
    const sessions = ticket.getByRole('group', { name: 'Trading sessions', exact: true });
    await expect(sessions.getByRole('button', { name: 'Regular', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(sessions.getByRole('button', { name: '+ Extended', exact: true })).toBeDisabled();
    await ticket.getByLabel('Stop-loss price', { exact: true }).fill('101.2');
    await expect(ticket.getByRole('alert')).toContainText('below'); await expect(ticket.locator('.submit-order')).toBeDisabled();
    await ticket.getByLabel('Stop-loss price', { exact: true }).fill('98.501');
    await expect(ticket.getByRole('alert')).toContainText('increments');
    await ticket.getByLabel('Stop-loss price', { exact: true }).fill('98.5');
    await expect(ticket.getByRole('region', { name: 'Order summary' })).toContainText('Stop $98.50 → market after full buy fill.');
    await ticket.getByRole('button', { name: 'Buy SPY', exact: true }).click();
    await expect(ticket.getByRole('status')).toContainText('waiting for full buy fill');
    expect(broker.writes).toHaveLength(1);
    expect(broker.writes[0].body).toMatchObject({ side: 'buy', type: standalone ? 'market' : 'limit', qty: '2', order_class: 'oto', stop_loss: { stop_price: '98.5' }, time_in_force: standalone ? 'gtc' : 'day', extended_hours: false });
    Object.assign(broker.orders[0], { status: 'filled', filled_qty: '2', filled_avg_price: '101.2' });
    broker.positions = [{ symbol: 'SPY', side: 'long', qty: '2', avg_entry_price: '101.2' }];
    await page.getByRole('button', { name: 'Reconcile account', exact: true }).click();
    await expect(ticket.getByRole('status')).toContainText('Stop loss at $98.50: new');
    await expect.poll(async () => (await stored(page, 'manualCommands'))[0].commitmentCents).toBe(0);
    await page.reload(); await broker.ready(page);
    await page.getByRole('button', { name: 'Orders (1)', exact: true }).click();
    const stopRow = page.getByRole('row').filter({ hasText: 'Stop $98.5' });
    await expect(stopRow).toContainText(standalone ? 'GTC' : 'DAY');
    await stopRow.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect.poll(async () => (await stored(page, 'manualCommands')).every(command => command.status === 'resolved')).toBe(true);
    expect(broker.writes.filter(write => write.method === 'POST')).toHaveLength(1);
    expect(broker.writes.filter(write => write.method === 'DELETE')).toHaveLength(1);
    expect(broker.errors).toEqual([]);
  });

  test(`${standalone ? 'standalone' : 'development'} sell Stop validates the trigger and confirms a conditional full exit`, async ({ page }) => {
    const broker = new BrokerFixture();
    broker.positions = [{ symbol: 'SPY', side: 'long', qty: '2', avg_entry_price: '90' }];
    await broker.install(page, standalone); await broker.connected(page);
    const ticket = page.locator('.order-ticket');
    await ticket.getByRole('button', { name: 'Sell holdings', exact: true }).click();
    await ticket.getByRole('button', { name: 'Stop', exact: true }).click();
    await ticket.getByLabel('Quantity', { exact: true }).fill('2');
    await ticket.getByLabel('Stop price', { exact: true }).fill('101.2');
    await expect(ticket.getByRole('alert')).toContainText('below the current market price');
    await ticket.getByLabel('Stop price', { exact: true }).fill('95.001');
    await expect(ticket.getByRole('alert')).toContainText('increments');
    await ticket.getByLabel('Stop price', { exact: true }).fill('95');
    if (standalone) await ticket.getByRole('group', { name: 'Duration', exact: true }).getByRole('button', { name: 'GTC', exact: true }).click();
    await expect(ticket.getByRole('region', { name: 'Order summary' })).toContainText('Position if triggered');
    await ticket.getByRole('button', { name: 'Sell SPY', exact: true }).click();
    const confirmation = ticket.getByRole('region', { name: 'Confirm order', exact: true });
    await expect(confirmation).toContainText('if the stop triggers'); expect(broker.writes).toHaveLength(0);
    await confirmation.getByRole('button', { name: 'Confirm sell SPY', exact: true }).click();
    await expect(ticket.getByRole('status')).toContainText('Sell 2 SPY · stop at $95. Order acknowledged');
    expect(broker.writes[0].body).toMatchObject({ type: 'stop', side: 'sell', qty: '2', stop_price: '95', time_in_force: standalone ? 'gtc' : 'day', extended_hours: false });
    expect(broker.writes[0].body).not.toHaveProperty('limit_price');
    await ticket.getByRole('button', { name: 'New order', exact: true }).click();
    await ticket.getByRole('button', { name: 'Buy', exact: true }).click();
    await expect(ticket.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
    await expect(ticket.getByRole('button', { name: 'Market', exact: true })).toHaveAttribute('aria-pressed', 'true');
    expect(broker.errors).toEqual([]);
  });
}
