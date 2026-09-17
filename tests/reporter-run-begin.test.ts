import { describe, expect, test } from 'bun:test'

import { CrvyRprtr } from '../src/reporter'

type SentMessage = { type: string; data: Record<string, unknown> }

interface ReporterSeams {
  send: (m: unknown) => void
  transport: { start: () => void }
  onBegin: (config: object, suite: object) => void
  onTestBegin: (test: object) => void
}

function makeTest(id: string, title: string): object {
  return {
    id,
    title,
    location: { file: '/proj/tests/example.spec.ts', line: 1 },
    titlePath: () => ['', 'chromium', '/proj/tests/example.spec.ts', 'Suite', title],
    parent: {
      title: 'Suite',
      type: 'describe',
      project: () => ({ name: 'chromium', testDir: '/proj/tests', snapshotDir: '/proj/tests', use: {} }),
      parent: undefined,
    },
  }
}

function makeConfig(): object {
  return {
    configFile: undefined,
    rootDir: '/proj',
    metadata: undefined,
    projects: [],
  }
}

/** Instantiates the real reporter with a stubbed `send` and a no-op transport. */
function createReporter(ci: boolean): { reporter: ReporterSeams; sent: SentMessage[] } {
  const reporter = new CrvyRprtr({ ci, screenshotDir: './test-screenshots' })
  const sent: SentMessage[] = []
  const reporterSeams = reporter as unknown as ReporterSeams
  reporterSeams.send = (m: unknown): void => {
    sent.push(m as SentMessage)
  }
  reporterSeams.transport.start = (): void => {}
  return { reporter: reporterSeams, sent }
}

describe('reporter run-begin announcement', () => {
  test('onBegin announces the run test ids after register and before the first test', () => {
    const { reporter, sent } = createReporter(false)
    const first = makeTest('t1', 'first')
    const second = makeTest('t2', 'second')

    reporter.onBegin(makeConfig(), { allTests: () => [first, second] })
    reporter.onTestBegin(first)

    expect(sent.map((m) => m.type)).toEqual(['register', 'run-begin', 'test-begin'])
    expect(sent[1]?.data).toEqual({ testIds: ['t1', 't2'] })
  })

  test('announces nothing in CI mode', () => {
    const { reporter, sent } = createReporter(true)

    reporter.onBegin(makeConfig(), { allTests: () => [makeTest('t1', 'first')] })

    expect(sent).toHaveLength(0)
  })
})
