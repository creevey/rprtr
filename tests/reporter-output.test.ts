import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import { CrvyRprtr, type ReporterSeams } from '../src/reporter'
import type { CrvyRprtrOptions } from '../src/reporter-helpers'

type SentMessage = { type: string; data?: unknown }

/** The reporter hooks this suite drives; `onError`/`onStdOut`/`onStdErr` are optional on `Reporter`. */
interface ReporterHooks {
  onBegin: (config: object, suite: object) => void
  onTestBegin: (test: object) => void
  onTestEnd: (test: object, result: object) => Promise<void>
  onEnd: (result: { status: string }) => Promise<void>
  onError?: (error: { message: string; stack?: string }) => void
  onStdOut?: (chunk: string) => void
  onStdErr?: (chunk: string) => void
}

interface Harness {
  reporter: ReporterHooks
  stdout: string[]
  stderr: string[]
  sent: SentMessage[]
}

/**
 * Instantiates the real reporter with write seams and a stubbed transport, so
 * forwarded output is captured without touching the process streams and no
 * WebSocket is opened.
 */
function construct(options: CrvyRprtrOptions = {}, seams: Partial<ReporterSeams> = {}): Harness {
  const stdout: string[] = []
  const stderr: string[] = []
  const sent: SentMessage[] = []
  const reporter = new CrvyRprtr(
    { ci: true, screenshotDir: './test-screenshots', ...options },
    {
      env: {},
      log: (): void => undefined,
      fontconfig: { platform: 'darwin', exists: (): boolean => false },
      stdout: (chunk: string): void => void stdout.push(chunk),
      stderr: (chunk: string): void => void stderr.push(chunk),
      ...seams,
    },
  )
  const internals = reporter as unknown as {
    send: (message: unknown) => void
    transport: { start: () => void }
  }
  internals.send = (message: unknown): void => void sent.push(message as SentMessage)
  internals.transport.start = (): void => undefined
  return { reporter: reporter as unknown as ReporterHooks, stdout, stderr, sent }
}

const CONFIG = { configFile: '/proj/playwright.config.ts', rootDir: '/proj', metadata: {}, projects: [] }
const SUITE = { allTests: (): object[] => [] }

function makeTest(id: string, title: string): object {
  return {
    id,
    title,
    location: { file: '/proj/tests/example.spec.ts', line: 1, column: 1 },
    titlePath: () => ['', 'chromium', '/proj/tests/example.spec.ts', title],
    parent: {
      title: '',
      type: 'project',
      project: () => ({ name: 'chromium', testDir: '/proj/tests', snapshotDir: '/proj/tests', use: {} }),
      parent: undefined,
    },
  }
}

function makeResult(): object {
  return { status: 'failed', errors: [{ message: 'visual mismatch' }], duration: 5, steps: [], attachments: [] }
}

describe('CrvyRprtr runner output passthrough', () => {
  test('forwards a fatal error to stderr with its message and stack', () => {
    const { reporter, stdout, stderr } = construct()

    reporter.onError?.({
      message: 'webServer command exited early',
      stack: 'Error: webServer command exited early\n    at runWebServer (/proj/pw/webserver.ts:10:5)',
    })

    expect(stderr.join('')).toContain('webServer command exited early')
    expect(stderr.join('')).toContain('at runWebServer (/proj/pw/webserver.ts:10:5)')
    expect(stdout).toEqual([])
  })

  test('forwards a fatal error without a stack', () => {
    const { reporter, stderr } = construct()

    reporter.onError?.({ message: 'configuration is broken' })

    expect(stderr.join('')).toContain('configuration is broken')
  })

  test('forwards runner stdout and stderr chunks verbatim to the matching streams', () => {
    const { reporter, stdout, stderr } = construct()

    reporter.onStdOut?.('Starting webServer: npm run storybook\n')
    reporter.onStdErr?.('webServer stderr line\n')

    expect(stdout).toEqual(['Starting webServer: npm run storybook\n'])
    expect(stderr).toEqual(['webServer stderr line\n'])
  })

  test('forwards errors and process output in CI mode with no live transport', () => {
    const { reporter, stdout, stderr } = construct({ ci: true, serverUrl: 'ws://127.0.0.1:1' })

    reporter.onError?.({ message: 'global setup failed' })
    reporter.onStdOut?.('chunk')
    reporter.onStdErr?.('err')

    expect(stderr.join('')).toContain('global setup failed')
    expect(stderr.at(-1)).toBe('err')
    expect(stdout).toEqual(['chunk'])
  })

  test('leaves emitted report messages unchanged', () => {
    const { reporter, sent } = construct({ ci: false })
    const first = makeTest('t1', 'first')

    reporter.onBegin(CONFIG, SUITE)
    reporter.onTestBegin(first)
    reporter.onError?.({ message: 'forwarded only' })
    reporter.onStdOut?.('forwarded only')
    reporter.onStdErr?.('forwarded only')

    expect(sent.map((message) => message.type)).toEqual(['register', 'run-begin', 'test-begin'])
  })
})

interface OfflineReport {
  version: number
  workers: number
  events: Array<{ type: string; data: unknown; timestamp?: number; workerIndex?: number }>
}

interface Artifacts {
  report: OfflineReport
  reportText: string
  html: string
}

async function runToArtifacts(root: string, forward: boolean): Promise<Artifacts> {
  const harness = construct({
    screenshotDir: join(root, 'screenshots'),
    offlineReportPath: join(root, 'crvy-rprtr-0.json'),
    reportHtmlPath: join(root, 'crvy-rprtr.html'),
  })
  const testCase = makeTest('t1', 'visual diff')

  if (forward) {
    harness.reporter.onError?.({ message: 'FORWARDED-ERROR', stack: 'Error: FORWARDED-ERROR' })
    harness.reporter.onStdOut?.('FORWARDED-STDOUT')
    harness.reporter.onStdErr?.('FORWARDED-STDERR')
  }

  harness.reporter.onBegin(CONFIG, SUITE)
  harness.reporter.onTestBegin(testCase)
  await harness.reporter.onTestEnd(testCase, makeResult())
  await harness.reporter.onEnd({ status: 'failed' })

  const reportText = await readFile(join(root, 'crvy-rprtr-0.json'), 'utf8')
  return {
    report: JSON.parse(reportText) as OfflineReport,
    reportText,
    html: await readFile(join(root, 'crvy-rprtr.html'), 'utf8'),
  }
}

function persistedEvents(report: OfflineReport): unknown[] {
  return report.events.map((event) => ({ type: event.type, data: event.data }))
}

describe('CrvyRprtr output passthrough artifacts', () => {
  let tempDir = ''

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'crvy-rprtr-output-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  test('forwarded output leaves persisted report state and offline artifacts unchanged', async () => {
    const control = await runToArtifacts(join(tempDir, 'control'), false)
    const forwarded = await runToArtifacts(join(tempDir, 'forwarded'), true)

    expect(persistedEvents(forwarded.report)).toEqual(persistedEvents(control.report))
    expect(forwarded.report.version).toBe(control.report.version)
    expect(forwarded.report.workers).toBe(control.report.workers)
    expect(forwarded.html).toBe(control.html)
    expect(forwarded.reportText).not.toContain('FORWARDED')
    expect(forwarded.html).not.toContain('FORWARDED')
  })
})
