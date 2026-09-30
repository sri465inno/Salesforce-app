import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './acceptance',
  timeout: 240_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  outputDir: '../test-results',
  use: { ...devices['Desktop Chrome'], trace: 'retain-on-failure' },
});
