import { defineConfig } from '@playwright/test'

/**
 * Fixture for the docker preflight listing: `reuseExistingServer` follows the host
 * `CI` unless the listing strips it the way the container environment does. The
 * container never receives `CI`, so the intent is always reuse there. The explicit
 * undefined/empty check is the lint-clean form of `!process.env.CI`.
 */
export default defineConfig({
  testDir: './tests',
  webServer: {
    command: 'node -e "setInterval(() => {}, 1000)"',
    url: 'http://localhost:65113',
    reuseExistingServer: process.env.CI === undefined || process.env.CI === '',
  },
  use: { baseURL: 'http://localhost:65113' },
})
