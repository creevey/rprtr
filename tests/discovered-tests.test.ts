import { describe, expect, spyOn, test } from 'bun:test'

import {
  DISCOVERED_ID_PREFIX,
  discoveredTestIdentity,
  mergeDiscoveredTests,
  reconcileDiscoveredTests,
  seedDiscoveredTests,
  startDiscoverySession,
  withoutDiscoveredTests,
  type DiscoveryListing,
  type DiscoverySession,
} from '../src/server/discovered-tests'
import type { ListResult } from '../src/server/list-spawn'
import type { RunContext } from '../src/server/run-controller'
import type { WatchFn, WatchHandle, WatchListener } from '../src/server/test-file-watcher'
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

describe('reconcileDiscoveredTests', () => {
  const keptFile = '/proj/tests/kept.test.ts'

  function loadedReport(): ReportData {
    return createReportData({
      'run-id-1': {
        id: 'run-id-1',
        titlePath: [],
        title: 'recorded',
        browser: 'chromium',
        location: { file: keptFile, line: 5 },
        status: 'failed',
        results: [{ status: 'failed', retries: 0 }],
        approved: { snapshot: 0 },
      },
      'discovered:tests/gone.test.ts:chromium:removed test': discoveredTest(
        'discovered:tests/gone.test.ts:chromium:removed test',
        { title: 'removed test', location: { file: '/proj/tests/gone.test.ts', line: 1 } },
      ),
    })
  }

  test('drops stale placeholders and adds newly listed tests as pending', () => {
    const reportData = loadedReport()

    const changed = reconcileDiscoveredTests(reportData, [
      discoveredTest('discovered:tests/kept.test.ts:chromium:recorded', {
        title: 'recorded',
        location: { file: keptFile, line: 5 },
      }),
      discoveredTest('discovered:tests/new.test.ts:chromium:new test', {
        title: 'new test',
        location: { file: '/proj/tests/new.test.ts', line: 3 },
      }),
    ])

    expect(changed).toBe(true)
    expect(Object.keys(reportData.tests)).toEqual(['run-id-1', 'discovered:tests/new.test.ts:chromium:new test'])
    expect(reportData.tests['discovered:tests/new.test.ts:chromium:new test']?.status).toBe('pending')
  })

  test('preserves recorded results and approvals without duplicates', () => {
    const reportData = loadedReport()
    const recorded = reportData.tests['run-id-1']

    reconcileDiscoveredTests(reportData, [
      discoveredTest('discovered:tests/kept.test.ts:chromium:recorded', {
        title: 'recorded',
        location: { file: keptFile, line: 5 },
      }),
    ])

    const ids = Object.keys(reportData.tests)
    expect(ids.filter((id) => id.startsWith('discovered:'))).toEqual([])
    expect(ids).toEqual(['run-id-1'])
    expect(reportData.tests['run-id-1']).toBe(recorded)
    expect(reportData.tests['run-id-1']?.status).toBe('failed')
    expect(reportData.tests['run-id-1']?.results?.[0]?.status).toBe('failed')
    expect(reportData.tests['run-id-1']?.approved).toEqual({ snapshot: 0 })
  })

  test('clears the whole discovered layer for a successful empty listing', () => {
    const reportData = loadedReport()

    const changed = reconcileDiscoveredTests(reportData, [])

    expect(changed).toBe(true)
    expect(Object.keys(reportData.tests)).toEqual(['run-id-1'])
  })

  test('returns false when the listing matches the current tree', () => {
    const reportData = createReportData()
    const listed = discoveredTest('discovered:tests/a.test.ts:chromium:listed', {
      title: 'listed',
      location: { file: '/proj/tests/a.test.ts', line: 1 },
    })

    expect(reconcileDiscoveredTests(reportData, [listed])).toBe(true)
    expect(reconcileDiscoveredTests(reportData, [listed])).toBe(false)
    expect(Object.keys(reportData.tests)).toEqual([listed.id])
    expect(reportData.tests[listed.id]?.status).toBe('pending')
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

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  const box: { resolve: ((value: T) => void) | null } = { resolve: null }
  const promise = new Promise<T>((resolve) => {
    box.resolve = resolve
  })
  return {
    promise,
    resolve: (value): void => {
      box.resolve?.(value)
    },
  }
}

const SESSION_RUN_CONTEXT: RunContext = {
  configFile: '/proj/vitest.config.ts',
  cwd: '/proj',
  rootDir: '/proj',
  runner: 'vitest',
}

const LISTED_A = discoveredTest('discovered:tests/a.test.ts:chromium:listed a', {
  title: 'listed a',
  location: { file: '/proj/tests/a.test.ts', line: 1 },
})

const LISTED_B = discoveredTest('discovered:src/b.test.ts:chromium:listed b', {
  title: 'listed b',
  location: { file: '/proj/src/b.test.ts', line: 1 },
})

const SESSION_DEBOUNCE_MS = 10

interface WatchRegistration {
  path: string
  closed: boolean
  emit: WatchListener
}

interface ListingCall {
  deferred: Deferred<ListResult<TestData>>
}

interface SessionHarness {
  session: DiscoverySession
  reportData: ReportData
  broadcasts: ClientWebSocketMessage[]
  logs: string[]
  watches: WatchRegistration[]
  listings: ListingCall[]
  findWatch: (path: string) => WatchRegistration | undefined
  resolveListing: (index: number, value: ListResult<TestData>) => void
}

function createSessionHarness(): SessionHarness {
  const reportData = createReportData()
  const broadcasts: ClientWebSocketMessage[] = []
  const logs: string[] = []
  const watches: WatchRegistration[] = []
  const listings: ListingCall[] = []

  const watch: WatchFn = (path, _options, listener): WatchHandle => {
    const registration: WatchRegistration = { path, closed: false, emit: listener }
    watches.push(registration)
    return {
      close: (): void => {
        registration.closed = true
      },
    }
  }

  const list: DiscoveryListing = (): Promise<ListResult<TestData>> => {
    const call: ListingCall = { deferred: deferred<ListResult<TestData>>() }
    listings.push(call)
    return call.deferred.promise
  }

  const session = startDiscoverySession({
    runContext: SESSION_RUN_CONTEXT,
    reportData,
    broadcast: (message): void => {
      broadcasts.push(message)
    },
    list,
    watch,
    debounceMs: SESSION_DEBOUNCE_MS,
    log: (message): void => {
      logs.push(message)
    },
  })

  return {
    session,
    reportData,
    broadcasts,
    logs,
    watches,
    listings,
    findWatch: (path): WatchRegistration | undefined => watches.find((registration) => registration.path === path),
    resolveListing: (index, value): void => {
      listings[index]?.deferred.resolve(value)
    },
  }
}

function flush(): Promise<void> {
  return Bun.sleep(SESSION_DEBOUNCE_MS * 2)
}

function settleDebounce(): Promise<void> {
  return Bun.sleep(SESSION_DEBOUNCE_MS * 10)
}

describe('startDiscoverySession', () => {
  test('seeds the tree from the initial listing and watches its directories', async () => {
    const h = createSessionHarness()
    expect(h.listings.length).toBe(1)

    h.resolveListing(0, { ok: true, entries: [LISTED_A] })
    await flush()

    expect(h.reportData.tests[LISTED_A.id]).toBeDefined()
    expect(h.broadcasts).toHaveLength(1)
    expect(h.findWatch('/proj/tests')?.closed).toBe(false)
  })

  test('runs one listing at a time and coalesces changes into one follow-up', async () => {
    const h = createSessionHarness()
    h.resolveListing(0, { ok: true, entries: [LISTED_A] })
    await flush()
    const testsWatch = h.findWatch('/proj/tests')

    testsWatch?.emit('change', 'a.test.ts')
    await settleDebounce()
    expect(h.listings.length).toBe(2)

    testsWatch?.emit('change', 'a.test.ts')
    testsWatch?.emit('change', 'a.test.ts')
    await settleDebounce()
    expect(h.listings.length).toBe(2)

    h.resolveListing(1, { ok: true, entries: [LISTED_A] })
    await flush()
    expect(h.listings.length).toBe(3)

    h.resolveListing(2, { ok: true, entries: [LISTED_A] })
    await flush()
    expect(h.listings.length).toBe(3)
    // The unchanged listing did not broadcast a second time.
    expect(h.broadcasts).toHaveLength(1)
  })

  test('queues changes while a run is in progress and flushes them on run settle', async () => {
    const h = createSessionHarness()
    h.resolveListing(0, { ok: true, entries: [LISTED_A] })
    await flush()
    const testsWatch = h.findWatch('/proj/tests')

    h.reportData.isRunning = true
    testsWatch?.emit('change', 'a.test.ts')
    await settleDebounce()
    expect(h.listings.length).toBe(1)

    h.reportData.isRunning = false
    h.session.notifyRunSettled()
    await flush()
    expect(h.listings.length).toBe(2)

    h.resolveListing(1, { ok: true, entries: [LISTED_A, LISTED_B] })
    await flush()
    expect(h.reportData.tests[LISTED_B.id]).toBeDefined()
  })

  test('a listing that completes during a run is applied only after the run settles', async () => {
    const h = createSessionHarness()
    h.resolveListing(0, { ok: true, entries: [LISTED_A] })
    await flush()
    const testsWatch = h.findWatch('/proj/tests')

    testsWatch?.emit('change', 'a.test.ts')
    await settleDebounce()
    expect(h.listings.length).toBe(2)

    h.reportData.isRunning = true
    h.resolveListing(1, { ok: true, entries: [LISTED_A, LISTED_B] })
    await flush()
    expect(h.reportData.tests[LISTED_B.id]).toBeUndefined()

    h.reportData.isRunning = false
    h.session.notifyRunSettled()
    await flush()
    expect(h.listings.length).toBe(3)

    h.resolveListing(2, { ok: true, entries: [LISTED_A, LISTED_B] })
    await flush()
    expect(h.reportData.tests[LISTED_B.id]).toBeDefined()
  })

  test('a failed listing logs once, keeps the tree, and keeps watching', async () => {
    const h = createSessionHarness()
    h.resolveListing(0, { ok: true, entries: [LISTED_A] })
    await flush()
    const testsWatch = h.findWatch('/proj/tests')
    const treeBefore = Object.keys(h.reportData.tests)

    testsWatch?.emit('change', 'a.test.ts')
    await settleDebounce()
    h.resolveListing(1, { ok: false, reason: 'exit' })
    await flush()

    expect(Object.keys(h.reportData.tests)).toEqual(treeBefore)
    expect(h.logs).toHaveLength(1)
    expect(h.logs[0]).toContain('VitestDiscovery')

    testsWatch?.emit('change', 'a.test.ts')
    await settleDebounce()
    expect(h.listings.length).toBe(3)
  })

  test('a successful listing widens the watched directories', async () => {
    const h = createSessionHarness()
    h.resolveListing(0, { ok: true, entries: [LISTED_A] })
    await flush()
    expect(h.findWatch('/proj/tests')).toBeDefined()
    expect(h.findWatch('/proj/src')).toBeUndefined()

    h.findWatch('/proj/tests')?.emit('change', 'a.test.ts')
    await settleDebounce()
    h.resolveListing(1, { ok: true, entries: [LISTED_A, LISTED_B] })
    await flush()

    expect(h.findWatch('/proj/src')).toBeDefined()
  })

  test('dispose cancels queued work and stops watching', async () => {
    const h = createSessionHarness()
    h.resolveListing(0, { ok: true, entries: [LISTED_A] })
    await flush()
    const testsWatch = h.findWatch('/proj/tests')

    testsWatch?.emit('change', 'a.test.ts')
    await settleDebounce()
    expect(h.listings.length).toBe(2)

    testsWatch?.emit('change', 'a.test.ts')
    await settleDebounce()
    h.session.dispose()
    h.resolveListing(1, { ok: true, entries: [LISTED_A, LISTED_B] })
    await flush()

    expect(h.listings.length).toBe(2)
    expect(h.reportData.tests[LISTED_B.id]).toBeUndefined()
    expect(h.watches.every((registration) => registration.closed)).toBe(true)
  })
})
