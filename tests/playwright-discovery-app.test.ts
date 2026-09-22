import { afterEach, describe, expect, setDefaultTimeout, spyOn, test } from 'bun:test'
import { mkdir, readFile, rm, writeFile } from 'fs/promises'
import { join } from 'path'

import { createServerApp, type ServerApp } from '../src/server/app'
import type { TestData } from '../src/types'

const TMP_ROOT = join(import.meta.dir, 'fixtures', 'playwright-discovery-tmp')

const PLAYWRIGHT_CONFIG = `import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests',
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
})
`

const SPEC_FILE = `import { expect, test } from '@playwright/test'

test('first discovered test', async () => {
  expect(1).toBe(1)
})

test.describe('group', () => {
  test('second discovered test', async () => {
    expect(1).toBe(1)
  })
})
`

setDefaultTimeout(60000)

async function createTempProject(files: Record<string, string>): Promise<string> {
  const projectDir = join(TMP_ROOT, `project-${process.pid}-${Math.random().toString(36).slice(2, 8)}`)
  for (const [filePath, content] of Object.entries(files)) {
    const absolutePath = join(projectDir, filePath)
    await mkdir(join(absolutePath, '..'), { recursive: true })
    await writeFile(absolutePath, content)
  }
  return projectDir
}

interface ReportApiBody {
  runEnabled?: boolean
  isRunning?: boolean
  tests?: Record<string, TestData>
}

async function waitFor(
  check: (body: ReportApiBody) => boolean,
  request: () => Promise<ReportApiBody>,
  timeoutMs = 30000,
): Promise<ReportApiBody> {
  const deadline = Date.now() + timeoutMs
  let body: ReportApiBody = {}
  while (Date.now() < deadline) {
    body = await request()
    if (check(body)) return body
    await Bun.sleep(250)
  }
  return body
}

async function startSeededApp(projectDir: string): Promise<ServerApp> {
  const previousCwd = process.cwd()
  process.chdir(projectDir)
  try {
    return await createServerApp({
      screenshotDir: join(projectDir, 'screenshots'),
      reportPath: join(projectDir, 'report.json'),
      staticDir: './dist',
      // Skip the docker daemon probe; these tests exercise the local seed path.
      runMode: 'local',
    })
  } finally {
    process.chdir(previousCwd)
  }
}

function createReportRequest(app: ServerApp): () => Promise<ReportApiBody> {
  return async () => {
    const res = await app.handleRequest(new Request('http://localhost/api/report'))
    return (await res.json()) as ReportApiBody
  }
}

afterEach(async () => {
  await rm(TMP_ROOT, { recursive: true, force: true })
})

describe('startup seeding', () => {
  let app: ServerApp | null = null

  afterEach(async () => {
    if (app !== null) {
      await app.close()
      app = null
    }
  })

  test('a seeded Playwright app exposes run controls and a pending tree without any run', async () => {
    const projectDir = await createTempProject({
      'playwright.config.ts': PLAYWRIGHT_CONFIG,
      'tests/one.spec.ts': SPEC_FILE,
    })
    app = await startSeededApp(projectDir)

    const body = await waitFor(
      (b) => b.runEnabled === true && Object.keys(b.tests ?? {}).length >= 2,
      createReportRequest(app),
    )

    expect(body.runEnabled).toBe(true)
    expect(body.isRunning).toBe(false)
    const tests = Object.values(body.tests ?? {})
    expect(tests.length).toBe(2)
    for (const discovered of tests) {
      expect(discovered.id.startsWith('discovered:')).toBe(true)
      expect(discovered.status).toBe('pending')
      expect(discovered.provider).toBe('playwright')
      expect(discovered.fileTokens).toEqual(['tests', 'one.spec.ts'])
      expect(discovered.browser).toBe('chromium')
    }
    const nested = tests.find((discovered) => discovered.title === 'second discovered test')
    expect(nested?.titlePath).toEqual(['group'])
  })

  test('a failing listing keeps the controls enabled, leaves the tree empty, and logs once', async () => {
    const errorSpy = spyOn(console, 'error')
    const projectDir = await createTempProject({
      'playwright.config.ts': `throw new Error('boom')\n`,
      'tests/one.spec.ts': SPEC_FILE,
    })
    app = await startSeededApp(projectDir)

    const body = await waitFor(
      (b) =>
        b.runEnabled === true && errorSpy.mock.calls.some((call) => String(call[0]).includes('PlaywrightDiscovery')),
      createReportRequest(app),
    )

    expect(body.runEnabled).toBe(true)
    expect(Object.keys(body.tests ?? {}).length).toBe(0)
    const discoveryLogs = errorSpy.mock.calls.filter((call) => String(call[0]).includes('PlaywrightDiscovery'))
    expect(discoveryLogs.length).toBe(1)
    errorSpy.mockRestore()
  })

  test('a streamed test-begin replaces its discovered placeholder and report.json keeps no discovered entries', async () => {
    const projectDir = await createTempProject({
      'playwright.config.ts': PLAYWRIGHT_CONFIG,
      'tests/one.spec.ts': SPEC_FILE,
    })
    app = await startSeededApp(projectDir)

    const body = await waitFor(
      (b) => b.runEnabled === true && Object.keys(b.tests ?? {}).length >= 2,
      createReportRequest(app),
    )
    expect(Object.keys(body.tests ?? {}).length).toBe(2)

    await app.handleWebSocketMessage(
      JSON.stringify({
        type: 'test-begin',
        data: {
          id: 'run-id-1',
          title: 'first discovered test',
          titlePath: [],
          fileTokens: ['tests', 'one.spec.ts'],
          browser: 'chromium',
          location: { file: join(projectDir, 'tests', 'one.spec.ts'), line: 1 },
        },
      }),
    )

    const afterBegin = await createReportRequest(app)()
    expect(afterBegin.tests?.['run-id-1']?.status).toBe('running')
    const remaining = Object.entries(afterBegin.tests ?? {}).filter(([id]) => id.startsWith('discovered:'))
    expect(remaining.length).toBe(1)
    expect(remaining[0]?.[1].title).toBe('second discovered test')

    await app.close()
    app = null

    const raw = await readFile(join(projectDir, 'report.json'), 'utf8')
    const persisted = JSON.parse(raw) as { tests: Record<string, TestData> }
    expect(Object.keys(persisted.tests)).toEqual(['run-id-1'])
    expect(persisted.tests['run-id-1']?.title).toBe('first discovered test')
  })
})
