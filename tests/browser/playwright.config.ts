import { defineConfig, devices } from '@playwright/test'

const CI = Boolean(process.env.CI)
const PORT = 5199

/**
 * Every project renders the same fixture at a fixed 800x600 CSS-pixel viewport and DPR 1, so
 * pixel regions in the specs map 1:1 onto screenshot pixels. Specs compare against the bare
 * page in the same browser instead of stored golden images, so browser upgrades do not need
 * re-baselining.
 */
const viewport = { width: 800, height: 600 }

export default defineConfig({
  testDir: './specs',
  fullyParallel: true,
  forbidOnly: CI,
  // A flaky rendering test should be fixed, not hidden behind a retry.
  retries: 0,
  workers: CI ? 2 : undefined,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  reporter: CI ? [['list'], ['github'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    colorScheme: 'light',
    reducedMotion: 'no-preference',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport, deviceScaleFactor: 1 },
    },
    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'], viewport, deviceScaleFactor: 1 },
    },
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'], viewport, deviceScaleFactor: 1 },
    },
  ],
  webServer: {
    command: `pnpm exec vite --config vite.config.ts --port ${PORT}`,
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: !CI,
    timeout: 60_000,
  },
})
