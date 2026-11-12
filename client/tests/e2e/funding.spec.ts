import { test, expect } from '@playwright/test';
import { fundingView } from '../../lib/near/funding';
import type { ChainMarket } from '../../lib/near/types';

test('funding signs, units, expiry, fallback, RPC failure and readiness stay conservative', async ({ page }) => {
  const now = 1_900_000_000;
  await page.clock.install({ time: new Date(now * 1000) });
  await page.clock.setFixedTime(new Date(now * 1000));
  let error = false, snapshot = now;
  let market: ChainMarket = { market_id: 1, symbol: 'NEAR', initial_margin_bps: 1000, maintenance_margin_bps: 500,
    max_open_interest: '1000000000', open_interest: '0', price: '100000000000000000000', timestamp: now,
    last_price: '100000000000000000000', funding_index: '0', funding_rate_bps: 20, funding_rate_ppm: 2000,
    paused: false, controller: { mode: 'ADAPTIVE', revision: 1, last_epoch: Math.floor(now / 3600),
      rate_applied_at: now, fallback: false, params: { oracle_max_age_sec: 10 } } };
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://127.0.0.1:3100') return route.abort(); // no public RPC/venue calls
    if (url.pathname === '/rpc-fixture') {
      const request = route.request().postDataJSON();
      const value = request?.params?.method_name === 'get_price' ? { price: market.price, timestamp: now }
        : request?.params?.method_name === 'open_interest' ? { long: '0', short: '0' } : [];
      return route.fulfill({ json: { jsonrpc: '2.0', id: 'nearflow', result: { result: [...Buffer.from(JSON.stringify(value))] } } });
    }
    if (url.pathname === '/api/markets/1') return route.fulfill({ status: error ? 503 : 200, json: error ? { error: 'fixture outage' }
      : { ...market, ...fundingView(market, snapshot), volume: '0', long_open_interest: '0', short_open_interest: '0' } });
    if (url.pathname === '/api/ready') return route.fulfill({ json: { ready: true, tokenMatches: true, asOf: now, readyUntil: now + 10 } });
    if (url.pathname.endsWith('/orderbook')) return route.fulfill({ json: { bids: [], asks: [], timestamp: now * 1000 } });
    if (url.pathname.startsWith('/api/')) return route.fulfill({ json: [] });
    return route.continue();
  });
  await page.goto('/trade/NEAR-PERP');
  const trigger = page.getByRole('button', { name: 'Funding details', exact: true });
  await expect(trigger).toContainText('+20.00 bps/hour');
  // Keyboard opens the same disclosure used by touch; Escape restores focus.
  await trigger.focus(); await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Funding details' });
  await expect(dialog).toContainText('Longs pay shorts');
  await expect(dialog).toContainText('2000 ppm');
  await expect(dialog).toContainText('not APR or promised carry');
  const detailsBox = await dialog.boundingBox();
  expect(detailsBox).not.toBeNull();
  expect(detailsBox!.y).toBeGreaterThanOrEqual(0);
  expect(detailsBox!.y + detailsBox!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  await page.screenshot({ path: `test-results/funding-active-${page.viewportSize()!.width}.png`, fullPage: true });
  await page.keyboard.press('Escape'); await expect(trigger).toBeFocused();
  await trigger.click();
  // Frozen successful responses cannot keep a cached rate accruing past its deadline.
  await page.clock.setFixedTime(new Date((now + 10) * 1000));
  await page.clock.fastForward(1000);
  await expect(dialog).toContainText('Quote expired; not accruing');
  await expect(dialog.getByText('0.00 bps/hour', { exact: true })).toBeVisible();
  await page.clock.setFixedTime(new Date((now + 12) * 1000));
  await page.clock.fastForward(1000);
  await page.keyboard.press('Escape');
  await expect(page.getByText(/Oracle readiness expired/)).toBeVisible();
  await trigger.click();
  market = { ...market, timestamp: now + 12, funding_rate_ppm: -2000, funding_rate_bps: -20,
    controller: { ...market.controller!, mode: 'BASELINE', rate_applied_at: now + 12 } };
  snapshot = now + 12; // simulated refreshed finalized read, not a real transaction
  await page.clock.fastForward(3000);
  await expect(dialog).toContainText('Shorts pay longs');
  await expect(dialog).toContainText('-20.00 bps/hour');
  market = { ...market, funding_rate_ppm: 0, funding_rate_bps: 0, controller: { ...market.controller!, fallback: true } };
  await page.clock.fastForward(3000);
  await expect(dialog).toContainText('Zero fallback');
  error = true;
  await page.clock.fastForward(3000);
  await expect(dialog).toContainText('RPC unavailable');
  await expect(dialog).not.toContainText('Stored quote');
  await expect(dialog.getByRole('heading', { name: 'Funding details' })).toBeVisible();
  await page.screenshot({ path: `test-results/funding-${(await page.viewportSize())!.width}.png`, fullPage: true });
});
