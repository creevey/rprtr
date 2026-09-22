import { afterEach, describe, expect, setDefaultTimeout, spyOn, test } from 'bun:test'
import { mkdir, readFile, rm, writeFile } from 'fs/promises'
import { join } from 'path'

import { createServerApp, type ServerApp } from '../src/server/app'
import { RunController, type ChildProcessLike, type RunControllerDeps } from '../src/server/run-controller'
import { resolveSeedRunContext } from '../src/server/vitest-seeding'
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

/**
 * A test file that appends to an out-of-project marker whenever Vitest collects
 * it — one marker byte per `vitest list` spawn, letting tests prove a refresh
 * did NOT run.
 */
function markerTestFile(markerPath: string, titles: string[]): string {
  const tests = titles.map((title) => `it(${JSON.stringify(title)}, () => {})`).join('\n')
  return `import { appendFileSync } from 'node:fs'\nimport { it } from 'vitest'\nappendFileSync(${JSON.stringify(markerPath)}, 'x')\n${tests}\n`
}

function createMarkerPath(label: string): string {
  return join(TMP_ROOT, `${label}-${process.pid}-${Math.random().toString(36).slice(2, 8)}.log`)
}

/**
 * Watcher startup can replay recent filesystem activity as one extra listing,
 * so tests wait until the marker stops growing before using it as a baseline.
 */
async function settledMarkerLength(path: string): Promise<number> {
  let stable = 0
  let last = -1
  for (let attempt = 0; attempt < 24 && stable < 3; attempt += 1) {
    const length = (await readFile(path, 'utf8')).length
    stable = length === last ? stable + 1 : 0
    last = length
    await Bun.sleep(500)
  }
  return last
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

describe('live refresh', () => {
  let app: ServerApp | null = null

  afterEach(async () => {
    if (app !== null) {
      await app.close()
      app = null
    }
  })

  test('a watched test file edit refreshes the pending tree without a run', async () => {
    const projectDir = await createTempProject({
      'vitest.config.ts': VITEST_CONFIG,
      'tests/one.test.ts': `import { it } from 'vitest'\nit('first discovered test', () => {})\n`,
    })
    app = await startSeededApp(projectDir)
    const request = createReportRequest(app)
    await waitFor((b) => Object.keys(b.tests ?? {}).length === 1, request)

    await writeFile(
      join(projectDir, 'tests', 'one.test.ts'),
      `import { it } from 'vitest'\nit('first discovered test', () => {})\nit('second discovered test', () => {})\n`,
    )
    const added = await waitFor(
      (b) => Object.values(b.tests ?? {}).some((entry) => entry.title === 'second discovered test'),
      request,
    )
    const addedTest = Object.values(added.tests ?? {}).find((entry) => entry.title === 'second discovered test')
    expect(addedTest?.status).toBe('pending')
    expect(addedTest?.id?.startsWith('discovered:')).toBe(true)

    await writeFile(
      join(projectDir, 'tests', 'one.test.ts'),
      `import { it } from 'vitest'\nit('first discovered test', () => {})\n`,
    )
    const removed = await waitFor(
      (b) => !Object.values(b.tests ?? {}).some((entry) => entry.title === 'second discovered test'),
      request,
    )
    expect(Object.keys(removed.tests ?? {}).length).toBe(1)
  })

  test('an artifact-only write schedules no re-enumeration', async () => {
    const marker = createMarkerPath('artifact')
    const projectDir = await createTempProject({
      'vitest.config.ts': VITEST_CONFIG,
      'tests/one.test.ts': markerTestFile(marker, ['first discovered test']),
      'artifacts/keep.txt': '',
    })
    app = await startSeededApp(projectDir)
    const body = await waitFor((b) => Object.keys(b.tests ?? {}).length === 1, createReportRequest(app))
    expect(Object.keys(body.tests ?? {}).length).toBe(1)
    const listingsAfterSeed = await settledMarkerLength(marker)
    expect(listingsAfterSeed).toBeGreaterThan(0)

    const snapshotDir = join(projectDir, 'tests', 'one.test.ts-snapshots')
    await mkdir(snapshotDir, { recursive: true })
    await writeFile(join(snapshotDir, 'one-chromium-darwin.png'), 'png')
    await Bun.sleep(3000)

    expect((await readFile(marker, 'utf8')).length).toBe(listingsAfterSeed)
  })

  test('close() disposes watchers so later edits change nothing', async () => {
    const marker = createMarkerPath('close')
    const projectDir = await createTempProject({
      'vitest.config.ts': VITEST_CONFIG,
      'tests/one.test.ts': markerTestFile(marker, ['first discovered test']),
    })
    app = await startSeededApp(projectDir)
    const request = createReportRequest(app)
    await waitFor((b) => Object.keys(b.tests ?? {}).length === 1, request)
    const listingsBeforeClose = await settledMarkerLength(marker)

    const closedApp = app
    await closedApp.close()
    app = null

    await writeFile(
      join(projectDir, 'tests', 'one.test.ts'),
      markerTestFile(marker, ['first discovered test', 'late discovered test']),
    )
    await Bun.sleep(3000)

    expect((await readFile(marker, 'utf8')).length).toBe(listingsBeforeClose)
    const body = await createReportRequest(closedApp)()
    const titles = Object.values(body.tests ?? {}).map((entry) => entry.title)
    expect(titles).toEqual(['first discovered test'])
  })
  test('a file change during a streamed run applies only after run-end', async () => {
    const projectDir = await createTempProject({
      'vitest.config.ts': VITEST_CONFIG,
      'tests/one.test.ts': `import { it } from 'vitest'\nit('first discovered test', () => {})\n`,
    })
    app = await startSeededApp(projectDir)
    const request = createReportRequest(app)
    await waitFor((b) => Object.keys(b.tests ?? {}).length === 1, request)

    await app.handleWebSocketMessage(JSON.stringify({ type: 'run-begin', data: { testIds: ['run-id-1'] } }))
    await app.handleWebSocketMessage(
      JSON.stringify({
        type: 'test-begin',
        data: {
          id: 'run-id-1',
          title: 'first discovered test',
          titlePath: [],
          browser: 'chromium',
          location: { file: join(projectDir, 'tests', 'one.test.ts'), line: 1 },
        },
      }),
    )
    expect((await request()).isRunning).toBe(true)

    await writeFile(
      join(projectDir, 'tests', 'one.test.ts'),
      `import { it } from 'vitest'\nit('first discovered test', () => {})\nit('second discovered test', () => {})\n`,
    )
    await Bun.sleep(2500)
    const during = await request()
    expect(during.isRunning).toBe(true)
    expect(Object.values(during.tests ?? {}).some((entry) => entry.title === 'second discovered test')).toBe(false)
    expect(during.tests?.['run-id-1']?.status).toBe('running')

    await app.handleWebSocketMessage(JSON.stringify({ type: 'run-end', data: { status: 'passed' } }))
    const after = await waitFor(
      (b) => Object.values(b.tests ?? {}).some((entry) => entry.title === 'second discovered test'),
      request,
    )
    expect(after.isRunning).toBe(false)
    expect(after.tests?.['run-id-1']?.status).toBe('running')
    expect(Object.values(after.tests ?? {}).find((entry) => entry.title === 'second discovered test')?.status).toBe(
      'pending',
    )
  })

  test('a UI-launched run exit reconciles a change made while it ran', async () => {
    const projectDir = await createTempProject({
      'vitest.config.ts': VITEST_CONFIG,
      'tests/one.test.ts': `import { it } from 'vitest'\nit('first discovered test', () => {})\n`,
    })
    app = await startSeededApp(projectDir)
    const request = createReportRequest(app)
    await waitFor((b) => Object.keys(b.tests ?? {}).length === 1, request)

    const runResponse = await app.handleRequest(new Request('http://localhost/api/run', { method: 'POST', body: '{}' }))
    expect((await runResponse.json()) as { ok?: boolean }).toEqual({ ok: true })
    expect((await request()).isRunning).toBe(true)

    await writeFile(
      join(projectDir, 'tests', 'one.test.ts'),
      `import { it } from 'vitest'\nit('first discovered test', () => {})\nit('second discovered test', () => {})\n`,
    )

    const after = await waitFor(
      (b) =>
        b.isRunning === false && Object.values(b.tests ?? {}).some((entry) => entry.title === 'second discovered test'),
      request,
    )
    expect(after.isRunning).toBe(false)
    expect(Object.values(after.tests ?? {}).find((entry) => entry.title === 'second discovered test')?.status).toBe(
      'pending',
    )
  })
})

describe('starting a run from the UI', () => {
  test('keeps discovered entries so the sidebar structure stays put', () => {
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
