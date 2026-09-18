import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.spec.ts',
  fullyParallel: true,
  forbidOnly: process.env.CI !== undefined && process.env.CI !== '',
  retries: process.env.CI !== undefined && process.env.CI !== '' ? 2 : 0,
  workers: process.env.CI !== undefined && process.env.CI !== '' ? 1 : undefined,
  // `list` is load-bearing in CI: the crvy reporter and `html` both write to disk
  // and print nothing, so without it a failing run produces no console output at
  // all and a run that executed nothing looks exactly like one that passed.
  reporter: [['list'], ['./src/reporter.ts', { serverUrl: 'ws://localhost:3000' }], ['html']],
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: [
    {
      command: 'bun src/cli.ts',
      url: 'http://localhost:3000',
      reuseExistingServer: !(process.env.CI !== undefined && process.env.CI !== ''),
    },
    {
      command: 'bunx serve . --listen 3001 --no-clipboard --config serve.json',
      url: 'http://localhost:3001',
      reuseExistingServer: !(process.env.CI !== undefined && process.env.CI !== ''),
    },
  ],
})
