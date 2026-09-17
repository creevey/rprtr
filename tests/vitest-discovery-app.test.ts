import { afterEach, describe, expect, setDefaultTimeout, spyOn, test } from 'bun:test'
import { mkdir, readFile, rm, writeFile } from 'fs/promises'
import { join } from 'path'

import { createServerApp, type ServerApp } from '../src/server/app'
import { RunController, type ChildProcessLike, type RunControllerDeps } from '../src/server/run-controller'
import { mergeDiscoveredTests, type VitestListEntry } from '../src/server/vitest-discovery'
import { resolveSeedRunContext, withoutDiscoveredTests } from '../src/server/vitest-seeding'
import type { TestData } from '../src/types'

const TMP_ROOT = join(import.meta.dir, 'fixtures', 'vitest-discovery-tmp')
const VITEST_CONFIG = `import { defineConfig } from 'vitest/config'\nexport default defineConfig({})\n`

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

describe('resolveSeedRunContext', () => {
  test('discovers vitest.config.* when no playwright config exists', async () => {
    const projectDir = await createTempProject({
      'vitest.config.mts': `export default {}\n`,
    })
    const ctx = await resolveSeedRunContext(undefined, projectDir)
    expect(ctx).toEqual({
      configFile: join(projectDir, 'vitest.config.mts'),
      cwd: projectDir,
      rootDir: projectDir,
      runner: 'vitest',
    })
  })

  test('a discovered playwright config keeps precedence and skips vitest discovery', async () => {
    const projectDir = await createTempProject({
      'playwright.config.ts': `export default {}\n`,
      'vitest.config.ts': `export default {}\n`,
    })
    const ctx = await resolveSeedRunContext(undefined, projectDir)
    expect(ctx).toEqual({ configFile: join(projectDir, 'playwright.config.ts'), cwd: projectDir })
  })

  test('an explicit CLI --config keeps precedence over a discovered vitest config', async () => {
    const projectDir = await createTempProject({
      'vitest.config.ts': `export default {}\n`,
    })
    const ctx = await resolveSeedRunContext('./custom/playwright.config.ts', projectDir)
    expect(ctx).toEqual({
      configFile: join(projectDir, 'custom', 'playwright.config.ts'),
      cwd: projectDir,
    })
  })

  test('no configs at all yields no run context', async () => {
    const projectDir = await createTempProject({})
    expect(await resolveSeedRunContext(undefined, projectDir)).toBeNull()
  })
})

describe('startup seeding', () => {
  let app: ServerApp | null = null

  afterEach(async () => {
    if (app !== null) {
      await app.close()
      app = null
    }
  })

  test('a seeded app exposes run controls and a pending tree without any run', async () => {
    const projectDir = await createTempProject({
      'vitest.config.ts': VITEST_CONFIG,
      'tests/one.test.ts': `import { it } from 'vitest'\nit('first discovered test', () => {})\n`,
      'src/nested/two.test.ts': `import { it } from 'vitest'\nit('second discovered test', () => {})\n`,
    })
    app = await startSeededApp(projectDir)

    const body = await waitFor(
      (b) => b.runEnabled === true && Object.keys(b.tests ?? {}).length >= 2,
      createReportRequest(app),
    )

    expect(body.runEnabled).toBe(true)
    const tests = Object.values(body.tests ?? {})
    expect(tests.length).toBe(2)
    expect(body.isRunning).toBe(false)
    for (const discovered of tests) {
      expect(discovered.id?.startsWith('discovered:')).toBe(true)
      expect(discovered.status).toBe('pending')
    }
    expect(tests.map(({ title }) => title).sort()).toEqual(['first discovered test', 'second discovered test'])
  })

  test('a failing listing keeps the run controls enabled and logs once', async () => {
    const errorSpy = spyOn(console, 'error')
    const projectDir = await createTempProject({
      'vitest.config.ts': `throw new Error('boom')\n`,
      'tests/one.test.ts': `import { it } from 'vitest'\nit('never collected', () => {})\n`,
    })
    app = await startSeededApp(projectDir)

    const body = await waitFor(
      (b) => b.runEnabled === true && (errorSpy.mock.calls.length > 0 || Object.keys(b.tests ?? {}).length > 0),
      createReportRequest(app),
    )

    expect(body.runEnabled).toBe(true)
    expect(Object.keys(body.tests ?? {}).length).toBe(0)
    const discoveryLogs = errorSpy.mock.calls.filter((call) => String(call[0]).includes('VitestDiscovery'))
    expect(discoveryLogs.length).toBe(1)
    errorSpy.mockRestore()
  })

  test('the persisted report contains no discovered pending entries', async () => {
    const projectDir = await createTempProject({
      'vitest.config.ts': VITEST_CONFIG,
      'tests/one.test.ts': `import { it } from 'vitest'\nit('a discovered test', () => {})\n`,
    })
    app = await startSeededApp(projectDir)

    const body = await waitFor(
      (b) => b.runEnabled === true && Object.keys(b.tests ?? {}).length > 0,
      createReportRequest(app),
    )
    expect(Object.keys(body.tests ?? {}).length).toBeGreaterThan(0)

    // A real streamed test begins a save cycle alongside the discovered entries.
    await app.handleWebSocketMessage(
      JSON.stringify({
        type: 'test-begin',
        data: {
          id: 'run-id-1',
          title: 'a really run test',
          titlePath: [],
          browser: 'chromium',
          location: { file: join(projectDir, 'tests', 'one.test.ts'), line: 1 },
        },
      }),
    )
    await app.close()
    app = null

    const raw = await readFile(join(projectDir, 'report.json'), 'utf8')
    const persisted = JSON.parse(raw) as { tests: Record<string, TestData> }
    expect(Object.keys(persisted.tests)).toEqual(['run-id-1'])
    expect(persisted.tests['run-id-1']?.title).toBe('a really run test')
  })
})

describe('mergeDiscoveredTests', () => {
  const root = '/proj'

  function createReportData(tests: Record<string, TestData>): {
    isRunning: boolean
    isUpdateMode: boolean
    tests: Record<string, TestData>
  } {
    return { isRunning: false, isUpdateMode: false, tests }
  }

  function streamedTest(id: string, file: string, title: string, status: TestData['status']): TestData {
    return {
      id,
      titlePath: [],
      title,
      browser: 'chromium',
      location: { file, line: 5 },
      status,
      results: [{ status: status === 'success' ? 'success' : 'failed', retries: 0 }],
    }
  }

  test('discovered entries fill only identities absent from the loaded report', () => {
    const knownFile = '/proj/tests/button.test.ts'
    const reportData = createReportData({
      'run-id-1': streamedTest('run-id-1', knownFile, 'matches the button baseline', 'failed'),
    })

    const changed = mergeDiscoveredTests(
      reportData,
      [
        { name: 'matches the button baseline', file: knownFile, projectName: 'chromium' },
        { name: 'expands on click', file: '/proj/tests/expandable.test.ts', projectName: 'chromium' },
      ],
      root,
    )

    expect(changed).toBe(true)
    expect(reportData.tests['run-id-1']?.status).toBe('failed')
    expect(reportData.tests['run-id-1']?.results?.[0]?.status).toBe('failed')
    const discoveredIds = Object.keys(reportData.tests).filter((id) => id.startsWith('discovered:'))
    expect(discoveredIds.length).toBe(1)
    expect(reportData.tests[discoveredIds[0]!]?.status).toBe('pending')
    expect(reportData.tests[discoveredIds[0]!]?.title).toBe('expands on click')
  })

  test('merging the same entries twice adds nothing', () => {
    const entries: VitestListEntry[] = [{ name: 'expands on click', file: '/proj/tests/expandable.test.ts' }]
    const reportData = createReportData({})
    expect(mergeDiscoveredTests(reportData, entries, root)).toBe(true)
    const afterFirst = Object.keys(reportData.tests).length
    expect(mergeDiscoveredTests(reportData, entries, root)).toBe(false)
    expect(Object.keys(reportData.tests).length).toBe(afterFirst)
  })

  test('starting a run from the UI keeps discovered entries so the sidebar structure stays put', () => {
    const discoveredId = 'discovered:tests/a.test.ts:chromium:stale'
    const discovered: TestData = {
      id: discoveredId,
      titlePath: [],
      fileTokens: ['tests', 'a.test.ts'],
      title: 'stale',
      browser: 'chromium',
      status: 'pending',
    }
    const reportData = { isRunning: false, isUpdateMode: false, tests: { [discoveredId]: discovered } }
    const child: ChildProcessLike = {
      on: (() => {}) as ChildProcessLike['on'],
      kill: (): void => {},
    }
    const deps: RunControllerDeps = {
      getRunContext: () => ({ configFile: '/proj/vitest.config.ts', cwd: '/proj', rootDir: '/proj', runner: 'vitest' }),
      port: 3000,
      broadcast: (): void => {},
      setReportRunning: (): void => {},
      spawn: () => child,
      timers: { setTimeout: (): unknown => null, clearTimeout: (): void => {} },
      launcher: {
        mode: 'local',
        launch: () => ({ cmd: 'bun', args: ['x', 'vitest'], env: {} }),
      },
    }
    const controller = new RunController(deps)

    const result = controller.start({})

    expect(result).toEqual({ ok: true })
    expect(reportData.tests[discoveredId]).toBeDefined()
    expect(reportData.tests[discoveredId]?.status).toBe('pending')
  })
})

describe('withoutDiscoveredTests', () => {
  test('filters discovered ids but keeps every other field', () => {
    const data = {
      isRunning: false,
      isUpdateMode: true,
      browsers: ['chromium'],
      screenshotDir: './screenshots',
      tests: {
        'discovered:a': { id: 'discovered:a', titlePath: [], title: 'x', browser: 'chromium' } satisfies TestData,
        'run-id-1': { id: 'run-id-1', titlePath: [], title: 'y', browser: 'chromium' } satisfies TestData,
      },
    }
    const persisted = withoutDiscoveredTests(data)
    expect(Object.keys(persisted.tests)).toEqual(['run-id-1'])
    expect(persisted.isRunning).toBe(false)
    expect(persisted.isUpdateMode).toBe(true)
    expect(persisted.browsers).toEqual(['chromium'])
    expect(data.tests['discovered:a']).toBeDefined()
  })
})
