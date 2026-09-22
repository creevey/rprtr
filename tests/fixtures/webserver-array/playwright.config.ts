import { defineConfig } from '@playwright/test'

/**
 * Fixture for the config-dump integration test: a two-entry `webServer` array and a
 * project `baseURL`. Listed through this project's own Playwright, the resolved
 * config is only visible to a `v2` reporter — neither the JSON list report nor the
 * CLI exposes arrays or `use.baseURL`.
 */
export default defineConfig({
  testDir: './tests',
  webServer: [
    {
      command: 'node -e "setInterval(() => {}, 1000)"',
      name: 'storybook',
      url: 'http://localhost:65111',
      reuseExistingServer: true,
    },
    {
      command: 'node -e "setInterval(() => {}, 1000)"',
      port: 65112,
    },
  ],
  projects: [{ name: 'chromium', use: { baseURL: 'http://localhost:65111' } }],
})
