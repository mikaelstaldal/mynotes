import { defineConfig } from '@playwright/test';

// 8091, not 8080: this suite is one of three sibling suites (MyCal owns 8089,
// MyMail 8090) that implement the same cross-repo sidebar-footer contract, and
// they are routinely run side by side while comparing the three apps. Distinct
// ports mean all three can be up at once; test-e2e.sh additionally refuses to
// start if this one is already taken, because a suite that quietly runs against
// somebody else's server is the failure that reads as a pass.
const port = 8091;

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: `http://localhost:${port}`,
    // `on-first-retry` captures nothing while retries are 0 — the pairing MyCal's
    // config shipped with for a while, so its CI failures left only the list
    // reporter's text behind. These assertions are geometry ("expected 8,
    // received 9.5"), which is near-undebuggable without a trace, and the suite
    // gates publishing. Retries stay at 0: a flaky gate trains people to re-run
    // red builds, and the first real failure gets re-run with them.
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' },
    },
  ],
});
