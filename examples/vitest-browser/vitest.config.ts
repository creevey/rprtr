import { CrvyRprtrVitestReporter } from '@crvy/rprtr/vitest'
import { playwright } from '@vitest/browser-playwright'
import { defineConfig } from 'vitest/config'

const browserWsEndpoint = process.env.CRVY_RPRTR_BROWSER_WS

export default defineConfig({
  test: {
    browser: {
      enabled: true,
      headless: true,
      // Docker mode: rprtr spawns a warm `playwright run-server` sidecar and
      // exports its endpoint through CRVY_RPRTR_BROWSER_WS; the browser runs in
      // the same mcr.microsoft.com/playwright image as Playwright docker mode.
      // Without the env var (terminal/CI runs) the browser launches locally.
      provider: playwright({
        connectOptions:
          browserWsEndpoint === undefined || browserWsEndpoint === ''
            ? undefined
            : { wsEndpoint: browserWsEndpoint, exposeNetwork: '<loopback>' },
      }),
      instances: [{ browser: 'chromium' }],
    },
    // 'default' keeps vitest's usual terminal output (a custom-only reporters
    // array is silent, even on failures); CrvyRprtrVitestReporter adds live
    // streaming to the rprtr UI server, falling back to offline artifacts
    // (crvy-rprtr.html + crvy-rprtr-*.json) when no server is running.
    reporters: ['default', new CrvyRprtrVitestReporter({ browserPin: { browser: 'chromium', version: '147' } })],
  },
})
