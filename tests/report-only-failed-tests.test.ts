import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readFile, rm, mkdtemp } from 'fs/promises'
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

function makeTest(id: string, rootDir: string): object {
  return {
    id,
    title: id,
    location: { file: join(rootDir, 'tests', 'only-failed.spec.ts'), line: 1, column: 1 },
    titlePath: () => ['', 'chromium', id],
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

async function runTests(
  rootDir: string,
  reportOnlyFailedTests: boolean | undefined,
  results: Array<{ id: string; status: string }>,
): Promise<OfflineReport> {
  const offlineReportPath = join(rootDir, 'report.json')
  const reporter = new CrvyRprtr({
    ci: true,
    serverUrl: 'ws://127.0.0.1:1',
    screenshotDir: join(rootDir, 'screenshots'),
    offlineReportPath,
    reportHtmlPath: join(rootDir, 'crvy-rprtr.html'),
    ...(reportOnlyFailedTests === undefined ? {} : { reportOnlyFailedTests }),
  }) as unknown as TestReporter

  reporter.onBegin({ configFile: undefined, rootDir, workers: 1, metadata: {}, projects: [] }, { allTests: () => [] })
  for (const { id, status } of results) {
    const testCase = makeTest(id, rootDir)
    const result = { status, errors: [], duration: 1, steps: [], attachments: [], workerIndex: 0 }
    reporter.onTestBegin(testCase, result)
    await reporter.onTestEnd(testCase, result)
  }
  await reporter.onEnd({ status: 'failed' })

  const parsed = safeParse(OfflineReportSchema, JSON.parse(await readFile(offlineReportPath, 'utf8')))
  if (parsed === null) throw new Error('Invalid offline report format')
  return parsed
}

function testEvents(report: OfflineReport): string[] {
  return report.events
    .filter((event) => event.type !== 'run-end')
    .map((event) => `${event.type}:${(event.data as { id: string }).id}`)
}

describe('reportOnlyFailedTests', () => {
  let tempDir = ''

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'crvy-rprtr-only-failed-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  const mixed = [
    { id: 'passed', status: 'passed' },
    { id: 'failed', status: 'failed' },
    { id: 'skipped', status: 'skipped' },
    { id: 'timed-out', status: 'timedOut' },
  ]

  test('keeps every test by default', async () => {
    const report = await runTests(tempDir, undefined, mixed)
    expect(testEvents(report)).toHaveLength(8)
  })

  test('drops passed and skipped tests from CI artifacts', async () => {
    const report = await runTests(tempDir, true, mixed)
    expect(testEvents(report)).toEqual([
      'test-begin:failed',
      'test-end:failed',
      'test-begin:timed-out',
      'test-end:timed-out',
    ])
    expect(report.events.at(-1)?.type).toBe('run-end')
  })

  test('keeps the failed attempts of a test that passed on retry', async () => {
    const report = await runTests(tempDir, true, [
      { id: 'flaky', status: 'failed' },
      { id: 'flaky', status: 'passed' },
    ])
    expect(testEvents(report)).toEqual(['test-begin:flaky', 'test-end:flaky'])
  })

  test('is ignored outside CI so the live UI can still approve passing tests', () => {
    const transport = new ReporterTransport({ ci: false, reportOnlyFailedTests: true })
    expect(transport.keepsResult('passed', 'passed')).toBe(true)
  })
})
