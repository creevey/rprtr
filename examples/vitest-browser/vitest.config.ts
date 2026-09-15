import { CrvyRprtrVitestReporter } from '@crvy/rprtr/vitest'
import { playwright } from '@vitest/browser-playwright'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      instances: [{ browser: 'chromium' }],
    },
    // 'default' keeps vitest's usual terminal output (a custom-only reporters
    // array is silent, even on failures); CrvyRprtrVitestReporter adds live
    // streaming to the rprtr UI server, falling back to offline artifacts
    // (crvy-rprtr.html + crvy-rprtr-*.json) when no server is running.
    reporters: ['default', new CrvyRprtrVitestReporter()],
  },
})
