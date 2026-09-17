import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdir, readFile, rm, writeFile } from 'fs/promises'
import { join } from 'path'

import { createServerApp, type ServerApp } from '../src/server/app'
import type { TestData } from '../src/types'

const TMP_ROOT = join(import.meta.dir, 'fixtures', 'run-begin-tmp')

setDefaultTimeout(60000)

function completedTest(id: string, title: string, status: 'success' | 'failed'): TestData {
  return {
    id,
    titlePath: ['Suite'],
    title,
    browser: 'chromium',
    projectName: 'chromium',
    status,
    approved: { header: 1 },
    results: [
      {
        status,
        retries: 0,
        images: {
          header: {
            actual: `/screenshots/${id}/header-actual.png`,
            ...(status === 'failed' ? { diff: `/screenshots/${id}/header-diff.png` } : {}),
            source: status === 'failed' ? 'comparison' : 'baseline-only',
          },
        },
        visualDeclarations: [
          {
            visualName: 'header',
            kind: 'named',
            declaredName: 'header',
            snapshotBaseName: 'header',
            occurrenceIndex: 1,
          },
        ],
      },
    ],
  }
}

async function createProject(tests: Record<string, TestData>): Promise<string> {
  const projectDir = join(TMP_ROOT, `project-${process.pid}-${Math.random().toString(36).slice(2, 8)}`)
  await mkdir(projectDir, { recursive: true })
  await writeFile(join(projectDir, 'report.json'), JSON.stringify({ tests }))
  return projectDir
}

async function startApp(projectDir: string): Promise<ServerApp> {
  const previousCwd = process.cwd()
  process.chdir(projectDir)
  try {
    return await createServerApp({
      screenshotDir: join(projectDir, 'screenshots'),
      reportPath: join(projectDir, 'report.json'),
      staticDir: './dist',
      // Skip the docker daemon probe; these tests exercise the local path.
      runMode: 'local',
    })
  } finally {
    process.chdir(previousCwd)
  }
}

async function apiReport(app: ServerApp): Promise<{ tests?: Record<string, TestData> }> {
  const res = await app.handleRequest(new Request('http://localhost/api/report'))
  return (await res.json()) as { tests?: Record<string, TestData> }
}

async function sendRegister(app: ServerApp, projectDir: string): Promise<void> {
  await app.handleWebSocketMessage(
    JSON.stringify({
      type: 'register',
      data: { configFile: join(projectDir, 'playwright.config.ts'), cwd: projectDir },
    }),
  )
}

async function sendTestBegin(app: ServerApp, projectDir: string, id: string, title: string): Promise<void> {
  await app.handleWebSocketMessage(
    JSON.stringify({
      type: 'test-begin',
      data: {
        id,
        title,
        titlePath: ['Suite'],
        browser: 'chromium',
        projectName: 'chromium',
        location: { file: join(projectDir, 'tests', 'example.spec.ts'), line: 1 },
      },
    }),
  )
}

describe('run-begin integration', () => {
  let app: ServerApp | null = null

  afterEach(async () => {
    if (app !== null) {
      await app.close()
      app = null
    }
    await rm(TMP_ROOT, { recursive: true, force: true })
  })

  test('clears announced tests in the API and the persisted report, leaving others intact', async () => {
    const projectDir = await createProject({
      announced: completedTest('announced', 'will rerun', 'success'),
      kept: completedTest('kept', 'outside the run', 'failed'),
    })
    app = await startApp(projectDir)

    await sendRegister(app, projectDir)
    await app.handleWebSocketMessage(JSON.stringify({ type: 'run-begin', data: { testIds: ['announced'] } }))

    const afterBegin = await apiReport(app)
    expect(afterBegin.tests?.['announced']?.status).toBe('pending')
    expect(afterBegin.tests?.['announced']?.results).toBeUndefined()
    expect(afterBegin.tests?.['announced']?.approved).toBeUndefined()
    expect(afterBegin.tests?.['kept']?.status).toBe('failed')
    expect(afterBegin.tests?.['kept']?.results).toHaveLength(1)
    expect(afterBegin.tests?.['kept']?.approved).toEqual({ header: 1 })

    await sendTestBegin(app, projectDir, 'announced', 'will rerun')

    const afterStream = await apiReport(app)
    expect(afterStream.tests?.['announced']?.status).toBe('running')
    expect(afterStream.tests?.['announced']?.results).toBeUndefined()

    await app.close()
    app = null

    const persisted = JSON.parse(await readFile(join(projectDir, 'report.json'), 'utf8')) as {
      tests: Record<string, TestData>
    }
    expect(persisted.tests['announced']?.status).toBe('running')
    expect(persisted.tests['announced']?.results).toBeUndefined()
    expect(persisted.tests['announced']?.approved).toBeUndefined()
    expect(persisted.tests['kept']?.status).toBe('failed')
    expect(persisted.tests['kept']?.results).toHaveLength(1)
    expect(persisted.tests['kept']?.approved).toEqual({ header: 1 })
  })

  test('a reporter without run-begin still clears a re-run test on its own test-begin', async () => {
    const projectDir = await createProject({
      rerun: completedTest('rerun', 'will rerun', 'failed'),
      untouched: completedTest('untouched', 'never re-runs', 'success'),
    })
    app = await startApp(projectDir)

    await sendRegister(app, projectDir)
    await sendTestBegin(app, projectDir, 'rerun', 'will rerun')

    const report = await apiReport(app)
    expect(report.tests?.['rerun']?.status).toBe('running')
    expect(report.tests?.['rerun']?.results).toBeUndefined()
    expect(report.tests?.['rerun']?.approved).toBeUndefined()
    expect(report.tests?.['untouched']?.status).toBe('success')
    expect(report.tests?.['untouched']?.results).toHaveLength(1)
    expect(report.tests?.['untouched']?.approved).toEqual({ header: 1 })
  })
})
