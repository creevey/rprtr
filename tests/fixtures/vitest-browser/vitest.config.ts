import { playwright } from '@vitest/browser-playwright'
import { defineConfig } from 'vitest/config'

import { CrvyRprtrVitestReporter } from '../../../src/vitest.ts'

export default defineConfig({
  root: import.meta.dirname,
  define: {
    __HERO_COLOR__: JSON.stringify(process.env.VITEST_HERO_COLOR ?? '#2563eb'),
  },
  test: {
    include: ['./vitest.integration.browser.test.ts'],
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      instances: [
        {
          browser: 'chromium',
          viewport: { width: 180, height: 120 },
        },
      ],
    },
    reporters: [
      new CrvyRprtrVitestReporter({
        ci: true,
        serverUrl: 'ws://localhost:9999',
        screenshotDir: './output/screenshots',
        offlineReportPath: './output/crvy-rprtr-0.json',
        reportHtmlPath: './output/crvy-rprtr.html',
      }),
    ],
  },
})
