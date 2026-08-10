import { defineConfig } from '@playwright/test';

// 8091, not 8080: this suite is one of three sibling suites (MyCal owns 8089,
// MyMail 8090) that implement the same cross-repo sidebar-footer contract, and
// they are routinely run side by side while comparing the three apps. Distinct
// ports mean all three can be up at once; test-e2e.sh additionally refuses to
// start if this one is already taken, because a suite that quietly runs against
// somebody else's server is the failure that reads as a pass.
const port = 8091;
// The `-demo-server` process test-e2e.sh starts alongside the real one. A demo
// build has no database and no REST API, so it cannot be reached as a route on
// the server above; it is a second origin, and the demo-only spec runs against
// it in its own project.
const demoPort = 8092;
const DEMO_SPEC = /demo-.*\.spec\.ts/;

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
    // gates publishing in CI (see e2e/AGENTS.md), so a failure there is one
    // somebody has to diagnose from the artifacts alone.
    // Retries stay at 0: a flaky gate trains people to re-run red builds, and the
    // first real failure gets re-run with them.
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  // The two projects partition tests/ rather than overlapping it: everything
  // outside the demo spec needs the REST API to seed content and would fail
  // against a demo, and the demo spec needs the injected demo config and would
  // fail against the real server. Splitting on the filename keeps that a
  // property of where a test lives rather than of a tag somebody has to
  // remember — but it does mean a new demo spec must be named `demo-*.spec.ts`
  // to land in the right project, and a misnamed one runs against 8091 and
  // fails on the first assertion about the demo badge.
  projects: [
    {
      name: 'chromium',
      testIgnore: DEMO_SPEC,
      use: { browserName: 'chromium' },
    },
    {
      name: 'chromium-demo',
      testMatch: DEMO_SPEC,
      use: { browserName: 'chromium', baseURL: `http://localhost:${demoPort}` },
    },
  ],
});
