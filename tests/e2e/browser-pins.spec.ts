import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { pathToFileURL } from 'url'

import { expect, test } from '@playwright/test'

import type { ProjectEnvironment } from '../../src/schemas'

const isPlaywright = (): boolean =>
  process.env.PLAYWRIGHT_WORKER_INDEX !== undefined ||
  process.env.PW_TEST !== undefined ||
  process.env.PLAYWRIGHT_TEST !== undefined

if (isPlaywright()) {
  const DRIFT: ProjectEnvironment = {
    playwrightVersion: '1.59.0',
    browser: 'chromium',
    browserVersion: '149.0.7827.55',
    revision: '1290',
    pin: { browser: 'chromium', version: '147' },
    status: 'drift',
  }

  const PINNED: ProjectEnvironment = {
    playwrightVersion: '1.59.0',
    browser: 'firefox',
    browserVersion: '148.0.2',
    revision: '1511',
    pin: { browser: 'firefox', version: '148' },
    status: 'pinned',
  }

  const UNVERIFIABLE: ProjectEnvironment = {
    playwrightVersion: '1.59.0',
    browser: 'webkit',
    browserVersion: null,
    revision: null,
    pin: { browser: 'webkit', version: '26' },
    status: 'unverifiable',
  }

  test('shows pin badges and drift marking in the static artifact', async ({ page }) => {
    const { writeReportArtifact } = await import('../../src/report-artifact')
    const tempDir = await mkdtemp(join(tmpdir(), 'crvy-rprtr-browser-pins-browser-'))

    try {
      const reportHtmlPath = join(tempDir, 'crvy-rprtr.html')
      const testLocation = { file: 'visual.spec.ts', line: 3, column: 1 }

      await writeReportArtifact({
        events: [
          {
            type: 'test-begin',
            data: {
              id: 'test-drift',
              title: 'Drifted visual test',
              titlePath: [],
              fileTokens: ['visual.spec.ts'],
              browser: 'chromium',
              projectName: 'chromium',
              location: testLocation,
            },
          },
          {
            type: 'test-begin',
            data: {
              id: 'test-pinned',
              title: 'Pinned visual test',
              titlePath: [],
              fileTokens: ['visual.spec.ts'],
              browser: 'firefox',
              projectName: 'firefox',
              location: testLocation,
            },
          },
          {
            type: 'run-end',
            data: {
              status: 'passed',
              environments: { chromium: DRIFT, firefox: PINNED, webkit: UNVERIFIABLE },
            },
          },
        ],
        screenshotDir: join(tempDir, 'screenshots'),
        reportHtmlPath,
      })

      const artifactUrl = pathToFileURL(reportHtmlPath).href
      await page.goto(withTestPath(artifactUrl, ['visual.spec.ts', 'Drifted visual test', 'chromium']))

      // Run header: one badge per project with a visible status.
      const badges = page.getByTestId('environment-badge')
      await expect(badges).toHaveCount(3)
      await expect(page.locator('[data-testid="environment-badge"][data-pin-status="drift"]')).toContainText(
        'chromium · Drift',
      )
      await expect(page.locator('[data-testid="environment-badge"][data-pin-status="pinned"]')).toContainText(
        'firefox · Pinned',
      )
      await expect(page.locator('[data-testid="environment-badge"][data-pin-status="unverifiable"]')).toContainText(
        'webkit · Unverifiable',
      )
      await expect(page.locator('[data-testid="environment-badge"][data-pin-status="drift"]')).toHaveAttribute(
        'title',
        /149\.0\.7827\.55/,
      )

      // Project node: the drifted leaf is badged and marked.
      const driftBadge = page.locator('[data-testid="test-pin-badge"][data-pin-status="drift"]')
      await expect(driftBadge).toContainText('Drift')
      await expect(page.locator('[role="treeitem"][data-drift="true"]')).toHaveCount(1)

      await page.goto(withTestPath(artifactUrl, ['visual.spec.ts', 'Pinned visual test', 'firefox']))
      await expect(page.locator('[data-testid="test-pin-badge"][data-pin-status="pinned"]')).toContainText('Pinned')
      await expect(page.locator('[role="treeitem"][data-drift="true"]')).toHaveCount(0)
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })
}

function withTestPath(url: string, testPath: string[]): string {
  const parsed = new URL(url)
  testPath.forEach((token, index) => {
    parsed.searchParams.set(`testPath[${index}]`, token)
  })
  return parsed.href
}
