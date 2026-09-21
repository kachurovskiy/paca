import { test, expect } from '@playwright/test';
import { BrokerFixture, MINUTE, OPEN, stored } from './support/broker';

for (const standalone of [false, true]) for (const cash of [50000, 2500]) test(`${standalone ? 'standalone' : 'development'} robot budgets scale to equity within $${cash} cash and recheck funds on approval`, async ({ page }) => {
  test.setTimeout(60_000);
  const broker = new BrokerFixture(true); broker.shortResearch = true; broker.cash = cash; broker.buyingPower = 400000;
  const budget = Math.min(cash, broker.equity * .1);
  await broker.install(page, standalone); await broker.connected(page);
  await page.getByRole('link', { name: 'robots', exact: true }).click();
  await expect(page.getByText('New robots target 10% of account equity each.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Research opportunities', exact: true }).click();
  for (let i = 0; i < 50; i++) await broker.advance(page, 250);
  const proposal = page.locator('.robot-card').filter({ has: page.getByRole('heading', { name: /wick-capture/ }) }).first();
  await expect(proposal).toContainText(budget.toLocaleString('en-US', { style: 'currency', currency: 'USD' }));
  await expect(proposal).toContainText(`${budget / broker.equity * 100}% of equity at sizing`);
  const offers = (await stored(page, 'research')).filter(row => row.kind === 'proposal');
  expect(offers).toHaveLength(cash === 50000 ? 3 : 1);
  for (const offer of offers) expect(offer.proposal).toMatchObject({ capital: { ceilingCents: budget * 100, equityCents: 10000000 },
    risk: { budgetCents: budget * 20 }, allocatorPolicy: { version: 2 } });
  broker.cash = budget - 1;
  await proposal.getByRole('button', { name: 'Approve frozen plan' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'The full capital ceiling is unavailable.' })).toBeVisible();
  expect(broker.writes).toEqual([]); expect(await stored(page, 'runs')).toEqual([]);
  broker.cash = cash;
  await proposal.getByRole('button', { name: 'Approve frozen plan' }).click();
  await page.getByRole('button', { name: 'active', exact: true }).click();
  for (let i = 0; i < 7; i++) await broker.advance(page, 1000);
  await expect.poll(() => broker.writes.length).toBe(1);
  const order = broker.writes[0].body!, notional = Number(order.qty) * Number(order.limit_price);
  expect(notional).toBeLessThanOrEqual(budget); expect(notional).toBeGreaterThan(budget - Number(order.limit_price));
  expect((await stored(page, 'runs'))[0]).toMatchObject({ ceilingCents: budget * 100, approved: { plan: { capital: { ceilingCents: budget * 100 } } } });
  expect(broker.errors).toEqual([]);
});

for (const standalone of [false, true]) test(`${standalone ? 'standalone' : 'development'} robots supervise precise Alpaca timestamps and recover fills without duplicate entries`, async ({ page }) => {
  test.setTimeout(60_000);
  const broker = new BrokerFixture(true); broker.shortResearch = true;
  await broker.install(page, standalone); await broker.connected(page);
  await page.getByRole('link', { name: 'robots', exact: true }).click();
  await page.getByRole('button', { name: 'Research opportunities', exact: true }).click();
  for (let i = 0; i < 50; i++) await broker.advance(page, 250);
  const proposal = page.locator('.robot-card').filter({ has: page.getByRole('heading', { name: /wick-capture/ }) }).first();
  await proposal.getByRole('button', { name: 'Approve frozen plan' }).click();
  await page.getByRole('button', { name: 'active', exact: true }).click();
  for (let i = 0; i < 7; i++) await broker.advance(page, 1000);
  await expect.poll(() => broker.orders.length).toBe(1);
  const entry = broker.orders[0]; entry.submitted_at = entry.submitted_at.replace('Z', '123456Z');
  for (let i = 0; i < 7; i++) await broker.advance(page, 1000);
  await expect(page.locator('.robot-card')).toContainText('resting_bid');
  const time = new Date(broker.now - 1000).toISOString().replace('Z', '654321Z');
  Object.assign(entry, { status: 'filled', filled_qty: entry.qty, filled_avg_price: '101', filled_at: time, updated_at: time });
  broker.positions = [{ symbol: entry.symbol, qty: entry.qty, avg_entry_price: '101', side: 'long' }];
  broker.activities.push({ activity_type: 'FILL', id: 'precise-buy-fill', order_id: entry.id, symbol: entry.symbol, side: 'buy',
    qty: entry.qty, price: '101', transaction_time: time, type: 'fill' });
  for (let i = 0; i < 7; i++) await broker.advance(page, 1000);
  await expect(page.locator('.robot-card')).toContainText('holding_fill');
  const checkpoint = broker.requests.length;
  for (let i = 0; i < 7; i++) await broker.advance(page, 1000);
  expect(broker.requests.slice(checkpoint).filter(url => url.pathname.startsWith('/v2/orders/'))).toEqual([]);
  expect((await stored(page, 'runs'))[0]).toMatchObject({
    strategy: { firstFillAt: new Date(time).toISOString() }, fills: [{ transactionTime: time }],
  });
  await page.reload(); await broker.ready(page);
  await page.getByRole('button', { name: 'active', exact: true }).click();
  await page.getByRole('button', { name: 'Reconcile runs', exact: true }).click();
  await page.getByRole('button', { name: 'Resume', exact: true }).click();
  for (let i = 0; i < 7; i++) await broker.advance(page, 1000);
  await expect(page.locator('.robot-card')).toContainText('holding_fill');
  await expect(page.locator('.robot-card')).toContainText(`confirmed inventory ${entry.qty}`);
  expect(broker.writes).toHaveLength(1); expect(broker.errors).toEqual([]);
});

for (const standalone of [false, true]) test(`${standalone ? 'standalone' : 'development'} full research completes on a throttled CPU and retains every strategy result`, async ({ page }) => {
  test.setTimeout(60_000);
  const broker = new BrokerFixture(false, true);
  const cpu = await page.context().newCDPSession(page); await cpu.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await broker.install(page, standalone); await broker.connected(page);
  await page.getByRole('link', { name: 'robots', exact: true }).click();
  await page.getByRole('button', { name: 'Research opportunities', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Research opportunities', exact: true })).toBeEnabled({ timeout: 20_000 });
  await page.getByRole('button', { name: 'research', exact: true }).click();
  await expect(page.getByRole('row').filter({ hasText: 'trend-legacy-experimental' })).toHaveCount(3);
  await expect(page.getByRole('row').filter({ hasText: 'wick-observed-experimental' })).toHaveCount(3);
  await expect(page.getByRole('row').filter({ hasText: 'vwap-chronological-experimental' })).toHaveCount(3);
  const experiment = (await stored(page, 'research')).find(row => row.kind === 'experiment');
  expect(experiment).toMatchObject({ report: { status: 'complete' } });
  await expect(page.locator('main')).not.toContainText('duration_budget');
  await expect(page.locator('main')).not.toContainText('fixed research deadline elapsed');
  expect(broker.writes).toEqual([]); expect(broker.errors).toEqual([]);
});

for (const standalone of [false, true]) test(`${standalone ? 'standalone' : 'development'} research explains exhausted portfolio stress budgets once and keeps long reasons expandable`, async ({ page }) => {
  test.setTimeout(60_000);
  const broker = new BrokerFixture(true); broker.shortResearch = true;
  broker.positions = [{ symbol: 'HELD', qty: '500', avg_entry_price: '100', side: 'long', market_value: '50000',
    current_price: '100', unrealized_pl: '0', unrealized_plpc: '0' }];
  await broker.install(page, standalone); await broker.connect(page);
  await expect(page.locator('.mode-badge')).toHaveText('Paper');
  for (let i = 0; i < 4; i++) await broker.advance(page, 250);
  await broker.ready(page);
  await page.getByRole('link', { name: 'robots', exact: true }).click();
  await page.getByRole('button', { name: 'Research opportunities', exact: true }).click();
  for (let i = 0; i < 50; i++) await broker.advance(page, 250);
  await expect(page.getByRole('button', { name: 'Research opportunities', exact: true })).toBeEnabled();
  const message = page.getByRole('status').filter({ hasText: 'Stress budget:' });
  await expect(message).toContainText('Stress budget: $0.00 remaining of $20,000.00; existing exposure stress $50,000.00');
  await expect(message).toContainText('per-run allowance $2,000.00');
  expect((await message.textContent())!.match(/Stress budget:/g)).toHaveLength(1);
  await expect(page.getByRole('button', { name: 'Approve frozen plan' })).toHaveCount(0);
  await page.getByRole('button', { name: 'research', exact: true }).click();
  await expect(page.getByText(/Selected research still needs available portfolio capacity/)).toBeVisible();
  const reason = page.locator('td details').first();
  await expect(reason.locator('summary')).toBeVisible(); await expect(reason.locator('p')).toBeHidden();
  await reason.locator('summary').click(); await expect(reason.locator('p')).toContainText('Simulated results are not a forecast.');
  expect(broker.writes).toEqual([]); expect(broker.errors).toEqual([]);
});

for (const standalone of [false, true]) test(`${standalone ? 'standalone' : 'development'} Monday 09:00 Berlin scanner handles sparse overnight bars and excludes unavailable universe rows`, async ({ page }) => {
  test.setTimeout(90_000);
  const broker = new BrokerFixture(true);
  broker.now = Date.parse('2026-09-21T07:00:06Z'); broker.sparseOvernightScanner = true; broker.scannerNoBars.add('QQQ');
  await broker.install(page, standalone); await broker.connected(page);
  await page.getByRole('link', { name: 'scanner', exact: true }).click();
  for (let i = 0; i < 30; i++) await broker.advance(page, 500);
  await expect(page.getByText(/2 histories ready/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'QQQ', exact: true })).toHaveCount(0);
  await expect(page.getByText('Fading', { exact: true })).toHaveCount(0);
  for (let i = 0; i < 370; i++) await broker.advance(page, 1000);
  const row = page.getByRole('row').filter({ has: page.getByRole('button', { name: 'STEADY', exact: true }) });
  await expect(row).toContainText('Clean uptrend');
  await row.getByRole('button', { name: 'monitoring', exact: true }).click();
  broker.scannerNoBars.add('STEADY');
  for (let i = 0; i < 70; i++) await broker.advance(page, 1000);
  await expect(row).toHaveCount(0);
  await page.getByRole('group', { name: 'Review filter' }).getByRole('button', { name: 'Monitoring', exact: true }).click();
  await expect(row).toContainText('Data unavailable');
  expect(broker.socketUrls.some(url => url.endsWith('/boats'))).toBe(true);
  expect(broker.requests.some(url => url.pathname === '/v2/stocks/bars' && url.searchParams.get('feed') === 'boats' && url.searchParams.has('page_token'))).toBe(true);
  expect(broker.writes).toEqual([]); expect(broker.errors).toEqual([]);
});

for (const standalone of [false, true]) test(`${standalone ? 'standalone' : 'development'} broad discovery qualifies non-movers with complete profiles and retains review choices`, async ({ page }) => {
  test.setTimeout(90_000);
  const broker = new BrokerFixture(true); await broker.install(page, standalone); await broker.connected(page);
  await page.getByRole('link', { name: 'scanner', exact: true }).click();
  for (let i = 0; i < 30; i++) await broker.advance(page, 500);
  await expect(page.getByText(/3 histories ready/)).toBeVisible();
  for (let i = 0; i < 190; i++) await broker.advance(page, 1000);
  const row = page.getByRole('row').filter({ has: page.getByRole('button', { name: 'STEADY', exact: true }) });
  await expect(row).toBeVisible();
  await expect(row).toContainText('Clean uptrend');
  await row.getByRole('button', { name: 'monitoring', exact: true }).click();
  await page.getByRole('group', { name: 'Review filter' }).getByRole('button', { name: 'Monitoring', exact: true }).click(); await expect(row).toBeVisible();
  await row.getByRole('button', { name: 'STEADY', exact: true }).click(); await expect(page.getByRole('region', { name: 'STEADY chart' })).toBeVisible();
  await expect(page.getByText('Qualifies now', { exact: false })).toBeVisible();
  expect((await stored(page, 'reviews')).some(value => value.symbol === 'STEADY' && value.choice === 'monitoring')).toBe(true);
  expect(broker.requests.some(url => url.pathname === '/v2/assets')).toBe(true);
  expect(broker.requests.some(url => url.searchParams.get('page_token') === '3000')).toBe(true);
  await page.reload(); await broker.ready(page);
  await page.getByRole('group', { name: 'Review filter' }).getByRole('button', { name: 'Monitoring', exact: true }).click(); await expect(page.getByRole('button', { name: 'STEADY', exact: true })).toBeVisible();
  expect(broker.writes).toEqual([]); expect(broker.errors).toEqual([]);
});

for (const standalone of [false, true]) for (const environment of ['paper', 'live']) test(`${standalone ? 'standalone' : 'development'} ${environment} research offers frozen Wick plans; navigation, pause, reload, reconciliation and close preserve authority`, async ({ page }) => {
  test.setTimeout(90_000);
  const broker = new BrokerFixture(true); broker.shortResearch = true; await broker.install(page, standalone); await broker.connect(page, environment);
  await expect(page.locator('.mode-badge')).toHaveText(environment === 'live' ? 'Live' : 'Paper');
  await page.getByRole('link', { name: 'robots', exact: true }).click();
  await expect(page.getByRole('heading', { name: environment === 'live' ? 'Live Robots' : 'Paper Robots' })).toBeVisible();
  await page.getByRole('button', { name: 'Research opportunities', exact: true }).click();
  for (let i = 0; i < 50; i++) await broker.advance(page, 250);
  await expect(page.getByRole('button', { name: 'Research opportunities', exact: true })).toBeEnabled();
  const proposal = page.locator('.robot-card').filter({ has: page.getByRole('heading', { name: /wick-capture/ }) }).first();
  await expect(proposal).toBeVisible(); await expect(proposal).toContainText('Forecast unavailable');
  await page.setViewportSize({ width: 390, height: 844 });
  await proposal.getByText('Strategy rationale & allocation details', { exact: true }).click();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await proposal.getByText('Strategy rationale & allocation details', { exact: true }).click();
  await page.setViewportSize({ width: 1440, height: 1100 });
  const approval = proposal.getByRole('button', { name: environment === 'live' ? 'Approve live plan' : 'Approve frozen plan' });
  if (environment === 'live') {
    await expect(approval).toBeDisabled();
    await page.getByLabel('Enable live Robot entries for this connection').check();
  }
  await approval.click();
  await page.getByRole('button', { name: 'active', exact: true }).click();
  await expect(page.locator('.robot-card')).toContainText('running');
  // Active commitments reduce the next allocation; they do not make all research unavailable.
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  const offersBefore = (await stored(page, 'research')).filter(row => row.kind === 'proposal').length;
  await page.getByRole('button', { name: 'Research opportunities', exact: true }).click();
  await expect(page.getByText('Research refresh is limited to once per 30 seconds')).toBeVisible();
  for (let i = 0; i < 20; i++) await broker.advance(page, 1000); // Research refreshes are limited to once per 30 seconds.
  await page.getByRole('button', { name: 'Research opportunities', exact: true }).click();
  for (let i = 0; i < 50; i++) await broker.advance(page, 250);
  await expect(page.getByRole('button', { name: 'Research opportunities', exact: true })).toBeEnabled();
  expect((await stored(page, 'research')).filter(row => row.kind === 'proposal').length).toBeGreaterThan(offersBefore);
  await page.getByRole('button', { name: 'Resume', exact: true }).click();
  await expect(page.locator('.robot-card')).toContainText('running');
  await page.getByRole('link', { name: 'history', exact: true }).click();
  for (let i = 0; i < 7; i++) await broker.advance(page, 1000);
  await expect.poll(() => broker.writes.length).toBe(1);
  expect(broker.writes[0].body).toMatchObject({ side: 'buy', type: 'limit' });
  await page.getByRole('link', { name: 'robots', exact: true }).click(); await page.getByRole('button', { name: 'active', exact: true }).click();
  await page.getByRole('button', { name: 'Pause', exact: true }).click(); await expect(page.locator('.robot-card')).toContainText('paused');
  await page.getByRole('button', { name: 'Resume', exact: true }).click(); await expect(page.locator('.robot-card')).toContainText('running');
  await page.reload(); await broker.ready(page, environment); await expect(page.locator('.mode-badge')).toHaveText(environment === 'live' ? 'Live' : 'Paper');
  await page.getByRole('button', { name: 'active', exact: true }).click(); await expect(page.locator('.robot-card')).toContainText('paused');
  for (let i = 0; i < 7; i++) await broker.advance(page, 1000);
  expect(broker.writes).toHaveLength(1);
  await page.getByRole('button', { name: 'Reconcile runs', exact: true }).click();
  if (environment === 'live') {
    await expect(page.getByLabel('Enable live Robot entries for this connection')).not.toBeChecked();
    await expect(page.getByRole('button', { name: 'Resume', exact: true })).toBeDisabled();
    await page.getByLabel('Enable live Robot entries for this connection').check();
  }
  await page.getByRole('button', { name: 'Resume', exact: true }).click(); await expect(page.locator('.robot-card')).toContainText('running');
  if (environment === 'live') await page.getByLabel('Enable live Robot entries for this connection').uncheck();
  await page.getByRole('button', { name: 'Close run', exact: true }).click();
  await expect.poll(() => broker.writes.length).toBe(2); expect(broker.writes[1].method).toBe('DELETE');
  await page.getByRole('button', { name: 'Reconcile runs', exact: true }).click();
  await expect(page.getByText('No active runs.')).toBeVisible();
  expect((await stored(page, 'runs'))[0]).toMatchObject({ state: 'ended', active: 0 });
  await page.getByRole('button', { name: 'outcomes', exact: true }).click(); await page.getByRole('button', { name: 'Refresh outcomes', exact: true }).click();
  await expect(page.getByText(/Missing fees, history and supervision remain explicit/)).toBeVisible();
  await page.getByRole('button', { name: 'forecasts', exact: true }).click(); await expect(page.locator('.robot-card').first()).toContainText('Forecast unavailable');
  const download = page.waitForEvent('download'); await page.getByRole('button', { name: 'Export research', exact: true }).click(); expect((await download).suggestedFilename()).toBe('paca-research.json');
  expect(broker.writes.every(write => write.origin === (environment === 'live' ? 'https://api.alpaca.markets' : 'https://paper-api.alpaca.markets'))).toBe(true);
  expect((await stored(page, 'runs'))[0]).toMatchObject({ approved: { scope: { environment } } });
  expect(broker.errors).toEqual([]);
});

test('live fills can be closed with entries disabled and retain live outcome provenance', async ({ page }) => {
  test.setTimeout(90_000);
  const broker = new BrokerFixture(true); broker.shortResearch = true;
  await broker.install(page); await broker.connect(page, 'live');
  await page.getByRole('link', { name: 'robots', exact: true }).click();
  await page.getByRole('button', { name: 'Research opportunities', exact: true }).click();
  for (let i = 0; i < 50; i++) await broker.advance(page, 250);
  const proposal = page.locator('.robot-card').filter({ has: page.getByRole('heading', { name: /wick-capture/ }) }).first();
  await expect(proposal).toBeVisible();
  await page.getByLabel('Enable live Robot entries for this connection').check();
  await proposal.getByRole('button', { name: 'Approve live plan' }).click();
  await page.getByRole('button', { name: 'active', exact: true }).click();
  for (let i = 0; i < 7; i++) await broker.advance(page, 1000);
  await expect.poll(() => broker.orders.length).toBe(1);
  const entry = broker.orders[0], time = new Date(broker.now).toISOString();
  Object.assign(entry, { status: 'filled', filled_qty: entry.qty, filled_avg_price: '100', filled_at: time, updated_at: time });
  broker.positions = [{ symbol: entry.symbol, qty: entry.qty, avg_entry_price: '100', side: 'long' }];
  broker.activities.push({ activity_type: 'FILL', id: 'live-buy-fill', order_id: entry.id, symbol: entry.symbol, side: 'buy', qty: entry.qty, price: '100', transaction_time: time, type: 'fill' });
  await page.getByLabel('Enable live Robot entries for this connection').uncheck();
  await page.getByRole('button', { name: 'Close run', exact: true }).click();
  for (let i = 0; i < 7; i++) await broker.advance(page, 1000);
  await expect.poll(() => broker.orders.length).toBe(2);
  expect(broker.writes[1]).toMatchObject({ method: 'DELETE', path: `/v2/orders/${entry.legs![0].id}` });
  expect(broker.writes[2]).toMatchObject({ origin: 'https://api.alpaca.markets', body: { side: 'sell', qty: entry.qty, type: 'market' } });
  const exit = broker.orders[1];
  Object.assign(exit, { status: 'filled', filled_qty: exit.qty, filled_avg_price: '101', filled_at: time, updated_at: time });
  broker.positions = [];
  broker.activities.push({ activity_type: 'FILL', id: 'live-sell-fill', order_id: exit.id, symbol: exit.symbol, side: 'sell', qty: exit.qty, price: '101', transaction_time: time, type: 'fill' });
  await page.getByRole('button', { name: 'Reconcile runs', exact: true }).click();
  await expect(page.getByText('No active runs.')).toBeVisible();
  const next = OPEN + 630 * MINUTE + 6000, elapsed = next - broker.now;
  broker.now = next; await page.clock.fastForward(elapsed); broker.quote(page);
  await page.getByRole('button', { name: 'outcomes', exact: true }).click();
  await page.getByRole('button', { name: 'Refresh outcomes', exact: true }).click();
  await expect(page.getByRole('cell', { name: 'live_execution', exact: true })).toBeVisible();
  const documents = await stored(page, 'research');
  expect(documents.some(row => row.kind === 'proposal' && (row.outcome as { provenance?: string } | null)?.provenance === 'live_execution')).toBe(true);
  expect(broker.writes).toHaveLength(3); expect(broker.errors).toEqual([]);
});

for (const standalone of [false, true]) test(`broker stop survives browser reload and its offline fill is recovered (${standalone ? 'standalone' : 'dev'})`, async ({ page }) => {
  test.setTimeout(90_000);
  const broker = new BrokerFixture(true); broker.shortResearch = true;
  await broker.install(page, standalone); await broker.connect(page, 'live');
  await page.getByRole('link', { name: 'robots', exact: true }).click();
  await page.getByRole('button', { name: 'Research opportunities', exact: true }).click();
  for (let i = 0; i < 50; i++) await broker.advance(page, 250);
  const proposal = page.locator('.robot-card').filter({ has: page.getByRole('heading', { name: /wick-capture/ }) }).first();
  await page.getByLabel('Enable live Robot entries for this connection').check();
  await proposal.getByRole('button', { name: 'Approve live plan' }).click();
  await page.getByRole('button', { name: 'active', exact: true }).click();
  for (let i = 0; i < 7; i++) await broker.advance(page, 1000);
  await expect.poll(() => broker.orders.length).toBe(1);
  expect(broker.writes[0].body).toMatchObject({ order_class: 'oto', time_in_force: 'gtc', stop_loss: { stop_price: expect.any(String) } });
  const entry = broker.orders[0], stop = entry.legs![0], time = new Date(broker.now).toISOString();
  Object.assign(entry, { status: 'filled', filled_qty: entry.qty, filled_avg_price: '100', filled_at: time });
  broker.positions = [{ symbol: entry.symbol, qty: entry.qty, avg_entry_price: '100', side: 'long' }];
  broker.activities.push({ activity_type: 'FILL', id: 'offline-entry', order_id: entry.id, symbol: entry.symbol, side: 'buy', qty: entry.qty, price: '100', transaction_time: time, type: 'fill' });
  await page.getByRole('button', { name: 'Reconcile runs', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Broker-held GTC stop covers' })).toBeVisible();
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  const resumeUrl = page.url(); await page.goto('about:blank');
  expect(stop.status).toBe('new'); expect(broker.writes).toHaveLength(1);
  Object.assign(stop, { status: 'filled', filled_qty: stop.qty, filled_avg_price: stop.stop_price, filled_at: time }); broker.positions = [];
  broker.activities.push({ activity_type: 'FILL', id: 'offline-stop', order_id: stop.id, symbol: stop.symbol, side: 'sell', qty: stop.qty, price: stop.stop_price, transaction_time: time, type: 'fill' });
  await page.goto(resumeUrl); await broker.ready(page, 'live');
  await page.getByRole('button', { name: 'active', exact: true }).click();
  await page.getByRole('button', { name: 'Reconcile runs', exact: true }).click();
  await expect(page.getByText('No Robot inventory.', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Enable live Robot entries for this connection')).not.toBeChecked();
  await page.getByRole('button', { name: 'Close run', exact: true }).click();
  await expect(page.getByText('No active runs.')).toBeVisible();
  const runs = await stored(page, 'runs');
  expect(runs[0]).toMatchObject({ state: 'ended', fills: [expect.objectContaining({ orderId: entry.id }), expect.objectContaining({ orderId: stop.id })] });
  expect(broker.writes).toHaveLength(1); expect(broker.errors).toEqual([]);
});

for (const standalone of [false, true]) for (const [label, at] of [['overnight', '2026-09-17T02:00:00Z'], ['premarket', '2026-09-17T11:00:00Z'], ['afterhours', '2026-09-17T22:00:00Z']]) test(`${standalone ? 'standalone' : 'development'} 24/5 ${label} research and Robot entry`, async ({ page }) => {
  test.setTimeout(90_000);
  const broker = new BrokerFixture(true); broker.now = Date.parse(at); broker.shortResearch = true;
  await broker.install(page, standalone); await broker.connected(page);
  await page.getByRole('link', { name: 'robots', exact: true }).click();
  await page.getByRole('button', { name: 'Research opportunities', exact: true }).click();
  for (let i = 0; i < 50; i++) await broker.advance(page, 250);
  const proposal = page.locator('.robot-card').filter({ has: page.getByRole('heading', { name: /wick-capture/ }) }).first();
  await expect(proposal).toBeVisible(); await expect(proposal).toContainText('24/5 including overnight');
  await proposal.getByRole('button', { name: 'Approve frozen plan', exact: true }).click();
  await page.getByRole('button', { name: 'active', exact: true }).click();
  for (let i = 0; i < 7; i++) await broker.advance(page, 1000);
  await expect.poll(() => broker.writes.length).toBe(1);
  expect(broker.writes[0].body).toMatchObject({ type: 'limit', side: 'buy', time_in_force: 'day', extended_hours: true });
  expect(broker.writes[0].body).not.toHaveProperty('stop_loss');
  await expect(page.locator('.robot-card')).toContainText('running');
  if (label === 'overnight') {
    expect(broker.socketUrls.some(url => url.endsWith('/boats'))).toBe(true);
    expect(broker.requests.some(url => url.pathname === '/v2/stocks/snapshots' && url.searchParams.get('feed') === 'boats')).toBe(true);
  }
  await page.getByRole('button', { name: 'Close run', exact: true }).click();
  await page.getByRole('button', { name: 'Reconcile runs', exact: true }).click();
  await expect(page.getByText('No active runs.')).toBeVisible(); expect(broker.errors).toEqual([]);
});
