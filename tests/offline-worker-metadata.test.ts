import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'fs'
import { mkdtemp, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import { CrvyRprtr } from '../src/reporter'
import { OfflineReportSchema, safeParse } from '../src/schemas'
import type { OfflineReport } from '../src/schemas'
import { ReporterTransport } from '../src/transport'

type TestReporter = {
  onBegin: (config: object, suite: object) => void
  onTestBegin: (test: object, result?: object) => void
  onTestEnd: (test: object, result: object) => Promise<void>
  onEnd: (result: { status: string }) => Promise<void>
}

function makeConfig(rootDir: string, workers: number): object {
  return { configFile: undefined, rootDir, workers, metadata: {}, projects: [] }
}

const SUITE = { allTests: (): object[] => [] }

function makeTest(id: string, title: string, rootDir: string): object {
  return {
    id,
    title,
    location: { file: join(rootDir, 'tests', 'worker-metadata.spec.ts'), line: 1, column: 1 },
    titlePath: () => ['', 'chromium', title],
    parent: {
      title: '',
      type: 'project',
      project: () => ({
        name: 'chromium',
        testDir: join(rootDir, 'tests'),
        snapshotDir: join(rootDir, 'tests'),
        use: {},
      }),
      parent: undefined,
    },
  }
}

function makeResult(workerIndex: number, status = 'passed'): object {
  return { status, errors: [], duration: 1, steps: [], attachments: [], workerIndex }
}

async function readReport(path: string): Promise<OfflineReport> {
  const parsed = safeParse(OfflineReportSchema, JSON.parse(await readFile(path, 'utf8')))
  if (parsed === null) throw new Error('Invalid offline report format')
  return parsed
}

async function runTests(options: {
  rootDir: string
  workers: number
  offlineReportPath?: string
  results: Array<{ id: string; workerIndex: number; status?: string }>
}): Promise<OfflineReport> {
  const reporter = new CrvyRprtr({
    ci: true,
    serverUrl: 'ws://127.0.0.1:1',
    screenshotDir: join(options.rootDir, 'screenshots'),
    ...(options.offlineReportPath === undefined ? {} : { offlineReportPath: options.offlineReportPath }),
    reportHtmlPath: join(options.rootDir, 'crvy-rprtr.html'),
  })
  const reporterAny = reporter as unknown as TestReporter

  reporterAny.onBegin(makeConfig(options.rootDir, options.workers), SUITE)
  for (const result of options.results) {
    const testCase = makeTest(result.id, result.id, options.rootDir)
    const testResult = makeResult(result.workerIndex, result.status ?? 'passed')
    reporterAny.onTestBegin(testCase, testResult)
    await reporterAny.onTestEnd(testCase, testResult)
  }
  await reporterAny.onEnd({ status: 'passed' })

  const reportPath = options.offlineReportPath ?? join(options.rootDir, 'crvy-rprtr-0.json')
  return readReport(reportPath)
}

describe('offline report worker metadata', () => {
  let tempDir = ''

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'crvy-rprtr-worker-metadata-'))
  })

  afterEach(async () => {
    if (tempDir !== '') {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  test('records configured workers and the worker that ran each Playwright test', async () => {
    const report = await runTests({
      rootDir: tempDir,
      workers: 2,
      offlineReportPath: join(tempDir, 'report.json'),
      results: [
        { id: 'first', workerIndex: 0 },
        { id: 'second', workerIndex: 1 },
      ],
    })

    expect(report.workers).toBe(2)
    expect(report.events.filter((event) => event.type !== 'run-end').map((event) => event.workerIndex)).toEqual([
      0, 0, 1, 1,
    ])
  })

  test('single-worker runs keep every test event at worker zero', async () => {
    const report = await runTests({
      rootDir: tempDir,
      workers: 1,
      offlineReportPath: join(tempDir, 'report.json'),
      results: [{ id: 'only', workerIndex: 0 }],
    })

    expect(report.workers).toBe(1)
    expect(report.events.filter((event) => event.type !== 'run-end').map((event) => event.workerIndex)).toEqual([0, 0])
  })

  test('normalizes an interrupted result worker index to zero', async () => {
    const report = await runTests({
      rootDir: tempDir,
      workers: 2,
      offlineReportPath: join(tempDir, 'report.json'),
      results: [{ id: 'interrupted', workerIndex: -1, status: 'interrupted' }],
    })

    expect(report.workers).toBe(2)
    expect(report.events.filter((event) => event.type !== 'run-end').map((event) => event.workerIndex)).toEqual([0, 0])
  })

  test('the default path is crvy-rprtr-0.json even when TEST_WORKER_INDEX is set', () => {
    const previous = process.env.TEST_WORKER_INDEX
    process.env.TEST_WORKER_INDEX = '7'
    try {
      const transport = new ReporterTransport({ ci: true })
      expect((transport as unknown as { offlineReportPath: string }).offlineReportPath).toBe('./crvy-rprtr-0.json')
    } finally {
      if (previous === undefined) delete process.env.TEST_WORKER_INDEX
      else process.env.TEST_WORKER_INDEX = previous
    }
  })

  test('an offlineReportPath containing a placeholder is written literally', async () => {
    const literalPath = join(tempDir, 'crvy-rprtr-{worker}.json')
    const report = await runTests({
      rootDir: tempDir,
      workers: 2,
      offlineReportPath: literalPath,
      results: [{ id: 'literal', workerIndex: 0 }],
    })

    expect(report.workers).toBe(2)
    expect(existsSync(literalPath)).toBe(true)
    expect(existsSync(join(tempDir, 'crvy-rprtr-0.json'))).toBe(false)
  })
})
