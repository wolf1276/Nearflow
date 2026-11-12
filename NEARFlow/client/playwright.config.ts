import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './tests/e2e', timeout: 45000, fullyParallel: false, workers: 1,
  use: { baseURL: 'http://127.0.0.1:3100', trace: 'retain-on-failure' },
  projects: [
    { name: 'desktop-chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile-chromium', use: { ...devices['Pixel 7'] } },
  ],
  webServer: {
    command: 'npm run dev -- --hostname 127.0.0.1 --port 3100', url: 'http://127.0.0.1:3100',
    timeout: 120000, reuseExistingServer: false,
    env: { NEARFLOW_E2E: '1', NEXT_PUBLIC_NEAR_NETWORK: 'testnet', NEXT_PUBLIC_NEAR_CONTRACT_ID: 'browser-fixture.testnet',
      NEXT_PUBLIC_NEAR_USDC_ID: 'browser-token.testnet', NEXT_PUBLIC_ACTIVE_MARKETS: 'NEAR-PERP',
      NEXT_PUBLIC_NEAR_RPC_URL: 'http://127.0.0.1:3100/rpc-fixture' },
  },
});
