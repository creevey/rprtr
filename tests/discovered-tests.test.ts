import { describe, expect, spyOn, test } from 'bun:test'

import {
  DISCOVERED_ID_PREFIX,
  discoveredTestIdentity,
  mergeDiscoveredTests,
  seedDiscoveredTests,
  withoutDiscoveredTests,
} from '../src/server/discovered-tests'
import type { RunContext } from '../src/server/run-controller'
import type { ClientWebSocketMessage, TestData } from '../src/types'

interface ReportData {
  isRunning: boolean
  isUpdateMode: boolean
  tests: Record<string, TestData>
}

function createReportData(tests: Record<string, TestData> = {}): ReportData {
  return { isRunning: false, isUpdateMode: false, tests }
}

function discoveredTest(id: string, overrides: Partial<TestData> = {}): TestData {
  return {
    id,
    titlePath: [],
    title: 'a discovered test',
    browser: 'chromium',
    status: 'pending',
    ...overrides,
  }
}

describe('DISCOVERED_ID_PREFIX', () => {
  test('marks synthesized ids so provenance stays explicit', () => {
    expect(DISCOVERED_ID_PREFIX).toBe('discovered:')
  })
})

describe('discoveredTestIdentity', () => {
  test('is (file, full title path) and distinguishes different tests', () => {
    expect(discoveredTestIdentity('/proj/tests/a.test.ts', 'outer > inner > does the thing')).toBe(
      discoveredTestIdentity('/proj/tests/a.test.ts', 'outer > inner > does the thing'),
    )
    expect(discoveredTestIdentity('/proj/tests/a.test.ts', 'a test')).not.toBe(
      discoveredTestIdentity('/proj/tests/b.test.ts', 'a test'),
    )
    expect(discoveredTestIdentity('/proj/tests/a.test.ts', 'a test')).not.toBe(
      discoveredTestIdentity('/proj/tests/a.test.ts', 'another test'),
    )
  })

  test('matches a streamed report test built from its location and title path', () => {
    const streamed: TestData = {
      id: 'runtime-id',
      titlePath: ['outer', 'inner'],
      title: 'does the thing',
      browser: 'chromium',
      location: { file: '/proj/tests/a.test.ts', line: 3 },
    }
    expect(discoveredTestIdentity('/proj/tests/a.test.ts', 'outer > inner > does the thing')).toBe(
      discoveredTestIdentity(streamed.location?.file ?? '', [...streamed.titlePath, streamed.title].join(' > ')),
    )
  })
})

describe('mergeDiscoveredTests', () => {
  const knownFile = '/proj/tests/button.test.ts'

  function loadedReport(): ReportData {
    return createReportData({
      'run-id-1': {
        id: 'run-id-1',
        titlePath: [],
        title: 'matches the button baseline',
        browser: 'chromium',
        location: { file: knownFile, line: 5 },
        status: 'failed',
        results: [{ status: 'failed', retries: 0 }],
      },
    })
  }

  test('fills only identities absent from the loaded report and never downgrades loaded results', () => {
    const reportData = loadedReport()

    const changed = mergeDiscoveredTests(reportData, [
      discoveredTest('discovered:tests/button.test.ts:chromium:matches the button baseline', {
        title: 'matches the button baseline',
        fileTokens: ['tests', 'button.test.ts'],
        location: { file: knownFile, line: 5 },
      }),
      discoveredTest('discovered:tests/expandable.test.ts:chromium:expands on click', {
        title: 'expands on click',
        fileTokens: ['tests', 'expandable.test.ts'],
        location: { file: '/proj/tests/expandable.test.ts', line: 3 },
      }),
    ])

    expect(changed).toBe(true)
    expect(reportData.tests['run-id-1']?.status).toBe('failed')
    expect(reportData.tests['run-id-1']?.results?.[0]?.status).toBe('failed')
    expect(Object.keys(reportData.tests)).toEqual([
      'run-id-1',
      'discovered:tests/expandable.test.ts:chromium:expands on click',
    ])
    expect(reportData.tests['discovered:tests/expandable.test.ts:chromium:expands on click']?.status).toBe('pending')
  })

  test('merging the same discovered tests twice adds nothing', () => {
    const discovered = [
      discoveredTest('discovered:tests/expandable.test.ts:chromium:expands on click', {
        title: 'expands on click',
        location: { file: '/proj/tests/expandable.test.ts', line: 3 },
      }),
    ]
    const reportData = createReportData()

    expect(mergeDiscoveredTests(reportData, discovered)).toBe(true)
    const afterFirst = Object.keys(reportData.tests).length
    expect(mergeDiscoveredTests(reportData, discovered)).toBe(false)
    expect(Object.keys(reportData.tests).length).toBe(afterFirst)
  })

  test('an existing id is never overwritten', () => {
    const id = 'discovered:tests/a.test.ts:chromium:renders the thing'
    const reportData = createReportData({
      [id]: discoveredTest(id, { status: 'running', title: 'renders the thing' }),
    })

    const changed = mergeDiscoveredTests(reportData, [
      discoveredTest(id, { status: 'pending', title: 'renders the thing' }),
    ])

    expect(changed).toBe(false)
    expect(reportData.tests[id]?.status).toBe('running')
  })

  test('discovered tests with no location are still added when their id is absent', () => {
    const reportData = createReportData()

    const changed = mergeDiscoveredTests(reportData, [
      discoveredTest('discovered:tests/a.test.ts:chromium:no location'),
    ])

    expect(changed).toBe(true)
    expect(reportData.tests['discovered:tests/a.test.ts:chromium:no location']).toBeDefined()
  })
})

describe('seedDiscoveredTests', () => {
  const VITEST_RUN_CONTEXT: RunContext = {
    configFile: '/proj/vitest.config.ts',
    cwd: '/proj',
    rootDir: '/proj',
    runner: 'vitest',
  }

  const LISTED = discoveredTest('discovered:tests/a.test.ts:chromium:listed', {
    title: 'listed',
    fileTokens: ['tests', 'a.test.ts'],
    location: { file: '/proj/tests/a.test.ts', line: 1 },
  })

  test('a failed startup listing logs once and leaves the tree untouched', async () => {
    const errorSpy = spyOn(console, 'error')
    const reportData = createReportData({
      'run-id-1': discoveredTest('run-id-1', { status: 'failed' }),
    })
    const broadcasts: ClientWebSocketMessage[] = []

    await seedDiscoveredTests({
      runContext: VITEST_RUN_CONTEXT,
      reportData,
      broadcast: (message): void => {
        broadcasts.push(message)
      },
      list: () => Promise.resolve({ ok: false, reason: 'exit' }),
    })

    expect(Object.keys(reportData.tests)).toEqual(['run-id-1'])
    expect(broadcasts).toEqual([])
    const logs = errorSpy.mock.calls.filter((call) => String(call[0]).includes('VitestDiscovery'))
    expect(logs.length).toBe(1)
    errorSpy.mockRestore()
  })

  test('a successful empty startup listing logs once and leaves the tree untouched', async () => {
    const errorSpy = spyOn(console, 'error')
    const reportData = createReportData()
    const broadcasts: ClientWebSocketMessage[] = []

    await seedDiscoveredTests({
      runContext: VITEST_RUN_CONTEXT,
      reportData,
      broadcast: (message): void => {
        broadcasts.push(message)
      },
      list: () => Promise.resolve({ ok: true, entries: [] }),
    })

    expect(Object.keys(reportData.tests)).toEqual([])
    expect(broadcasts).toEqual([])
    const logs = errorSpy.mock.calls.filter((call) => String(call[0]).includes('VitestDiscovery'))
    expect(logs.length).toBe(1)
    errorSpy.mockRestore()
  })

  test('a successful listing merges the discovered entries and broadcasts once', async () => {
    const reportData = createReportData()
    const broadcasts: ClientWebSocketMessage[] = []

    await seedDiscoveredTests({
      runContext: VITEST_RUN_CONTEXT,
      reportData,
      broadcast: (message): void => {
        broadcasts.push(message)
      },
      list: () => Promise.resolve({ ok: true, entries: [LISTED] }),
    })

    expect(reportData.tests[LISTED.id]).toBeDefined()
    expect(broadcasts).toEqual([{ type: 'sync', data: { tests: reportData.tests, isUpdateMode: false } }])
  })

  test('a run that started while the listing was in flight suppresses the merge', async () => {
    const reportData = createReportData()
    const broadcasts: ClientWebSocketMessage[] = []

    await seedDiscoveredTests({
      runContext: VITEST_RUN_CONTEXT,
      reportData,
      broadcast: (message): void => {
        broadcasts.push(message)
      },
      list: () => {
        reportData.isRunning = true
        return Promise.resolve({ ok: true, entries: [LISTED] })
      },
    })

    expect(Object.keys(reportData.tests)).toEqual([])
    expect(broadcasts).toEqual([])
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

  test('returns the same object when nothing was discovered', () => {
    const data = {
      isRunning: false,
      isUpdateMode: false,
      tests: { 'run-id-1': { id: 'run-id-1', titlePath: [], title: 'y', browser: 'chromium' } satisfies TestData },
    }
    expect(withoutDiscoveredTests(data)).toBe(data)
  })
})
