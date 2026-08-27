/**
 * End-to-end configuration. Build plan §27.6.
 *
 * These tests drive the real pages in a real browser: four origins, seven processes, real iframes,
 * a real consent panel with a real keyboard. Everything the Node suite proves about the hub's logic
 * it proves without a browser, which is the right way round — but a page can be entirely broken with
 * every unit test green, and the only thing that finds that is clicking it.
 *
 * The browser is launched with WebMCP testing enabled. If the flag is not honoured in the installed
 * Chromium, the hub falls back to its typed `postMessage` transport and these tests still pass: the
 * product above the transport interface is identical, which is exactly the property §47.2 claims and
 * therefore a property worth having the e2e suite exercise both ways.
 */

import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  // One worker. The providers hold genuinely scarce inventory in one process each, so two tests
  // running at once would contend for the same bed and fail in a way that says nothing.
  workers: 1,
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 8_000 },
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5100',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          args: [
            // The origin trial is not available on localhost, so the testing flag is how the real
            // mechanism is exercised locally. Chrome 149+.
            '--enable-features=WebMachineLearningModelContext,WebMCPTesting',
          ],
        },
      },
    },
  ],
  webServer: {
    command: 'node scripts/dev.mjs',
    url: 'http://localhost:5100',
    reuseExistingServer: true,
    timeout: 60_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
