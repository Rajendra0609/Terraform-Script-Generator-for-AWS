// tests/e2e/playwright.config.js
'use strict';

const { defineConfig, devices } = require('@playwright/test');

const BASE_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

module.exports = defineConfig({
  testDir:        './e2e',
  timeout:        60_000,
  expect:         { timeout: 10_000 },
  fullyParallel:  false,  // login state shared across tests
  retries:        process.env.CI ? 2 : 0,
  workers:        process.env.CI ? 1 : 2,

  reporter: [
    ['list'],
    ['junit', { outputFile: '../reports/e2e-junit.xml' }],
    ['html',  { outputFolder: '../reports/playwright-report', open: 'never' }],
  ],

  use: {
    baseURL:          BASE_URL,
    headless:         true,
    screenshot:       'only-on-failure',
    video:            'retain-on-failure',
    trace:            'on-first-retry',
    actionTimeout:    15_000,
    navigationTimeout: 30_000,
  },

  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox',  use: { ...devices['Desktop Firefox'] } },
  ],
});
