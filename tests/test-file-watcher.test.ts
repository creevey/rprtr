import { describe, expect, test } from 'bun:test'

import type { RunContext } from '../src/server/run-controller'
import {
  createTestFileWatcher,
  type TestFileWatcher,
  type WatchFn,
  type WatchHandle,
  type WatchListener,
} from '../src/server/test-file-watcher'

interface WatchCall {
  path: string
  recursive: boolean
  closed: boolean
  emit: WatchListener
}

interface FakeWatch {
  watch: WatchFn
  calls: WatchCall[]
}

function createFakeWatch(options: { failRecursive?: boolean } = {}): FakeWatch {
  const calls: WatchCall[] = []
  const watch: WatchFn = (path, watchOptions, listener) => {
    if (watchOptions.recursive === true && options.failRecursive === true) {
      throw new Error('ERR_FEATURE_UNAVAILABLE_ON_PLATFORM')
    }
    const call: WatchCall = { path, recursive: watchOptions.recursive === true, closed: false, emit: listener }
    calls.push(call)
    const handle: WatchHandle = {
      close: (): void => {
        call.closed = true
      },
    }
    return handle
  }
  return { watch, calls }
}

const VITEST_CTX: RunContext = {
  configFile: '/proj/vitest.config.ts',
  cwd: '/proj',
  rootDir: '/proj',
  runner: 'vitest',
}

const DEBOUNCE_MS = 10

interface WatcherHarness {
  watcher: TestFileWatcher
  changes: { count: number }
  logs: string[]
}

function createHarness(options: { fake?: FakeWatch; ignore?: readonly string[] } = {}): WatcherHarness {
  const fake = options.fake ?? createFakeWatch()
  const changes = { count: 0 }
  const logs: string[] = []
  const watcher = createTestFileWatcher({
    runContext: VITEST_CTX,
    debounceMs: DEBOUNCE_MS,
    watch: fake.watch,
    onChange: (): void => {
      changes.count += 1
    },
    log: (message): void => {
      logs.push(message)
    },
    ...(options.ignore === undefined ? {} : { ignore: options.ignore }),
  })
  return { watcher, changes, logs }
}

function findCall(calls: WatchCall[], path: string): WatchCall | undefined {
  return calls.find((call) => call.path === path)
}

function sleepPastDebounce(): Promise<void> {
  return Bun.sleep(DEBOUNCE_MS * 4)
}

describe('createTestFileWatcher root computation', () => {
  test('watches the runner config file and the run-context cwd non-recursively', () => {
    const fake = createFakeWatch()
    createHarness({ fake })

    expect(fake.calls.map(({ path, recursive }) => ({ path, recursive }))).toEqual([
      { path: '/proj/vitest.config.ts', recursive: false },
      { path: '/proj', recursive: false },
    ])
  })

  test('watches the deduped directories of listed files, recursively where available', () => {
    const fake = createFakeWatch()
    const { watcher } = createHarness({ fake })

    watcher.updateListedFiles(['/proj/tests/a.test.ts', '/proj/tests/b.test.ts', '/proj/src/nested/c.test.ts'])

    const dirs = fake.calls.filter((call) => call.path !== '/proj/vitest.config.ts' && call.path !== '/proj')
    expect(dirs.map(({ path, recursive }) => ({ path, recursive }))).toEqual([
      { path: '/proj/tests', recursive: true },
      { path: '/proj/src/nested', recursive: true },
    ])
  })
})

describe('createTestFileWatcher debounce', () => {
  test('coalesces rapid events into one change notification', async () => {
    const fake = createFakeWatch()
    const { watcher, changes } = createHarness({ fake })
    watcher.updateListedFiles(['/proj/tests/a.test.ts'])

    const dir = findCall(fake.calls, '/proj/tests')
    dir?.emit('change', 'a.test.ts')
    dir?.emit('change', 'b.test.ts')
    dir?.emit('rename', 'c.test.ts')
    await sleepPastDebounce()

    expect(changes.count).toBe(1)
  })

  test('a later burst schedules another change notification', async () => {
    const fake = createFakeWatch()
    const { watcher, changes } = createHarness({ fake })
    watcher.updateListedFiles(['/proj/tests/a.test.ts'])

    const dir = findCall(fake.calls, '/proj/tests')
    dir?.emit('change', 'a.test.ts')
    await sleepPastDebounce()
    dir?.emit('change', 'a.test.ts')
    await sleepPastDebounce()

    expect(changes.count).toBe(2)
  })
})

describe('createTestFileWatcher artifact filtering', () => {
  test('ignores generated-artifact locations and configured outputs', async () => {
    const fake = createFakeWatch()
    const { watcher, changes } = createHarness({
      fake,
      ignore: ['/proj/report.json', '/proj/screenshots'],
    })
    watcher.updateListedFiles(['/proj/tests/a.test.ts'])

    const cwd = findCall(fake.calls, '/proj')
    for (const filename of [
      'node_modules/pkg/index.js',
      '.git/HEAD',
      'dist/app.js',
      'coverage/lcov.info',
      'report.json',
      'screenshots/one.png',
      'tests/a.test.ts-snapshots/a-chromium-darwin.png',
      '__screenshots__/a.test.ts/a.png',
    ]) {
      cwd?.emit('change', filename)
    }
    await sleepPastDebounce()
    expect(changes.count).toBe(0)

    cwd?.emit('change', 'tests/a.test.ts')
    await sleepPastDebounce()
    expect(changes.count).toBe(1)
  })
})

describe('createTestFileWatcher recursive fallback', () => {
  test('watches non-recursively and logs once when recursive watching is unavailable', () => {
    const fake = createFakeWatch({ failRecursive: true })
    const { watcher, logs } = createHarness({ fake })

    watcher.updateListedFiles(['/proj/tests/a.test.ts', '/proj/src/nested/b.test.ts'])

    const dirs = fake.calls.filter((call) => call.path !== '/proj/vitest.config.ts' && call.path !== '/proj')
    expect(dirs.map(({ path, recursive }) => ({ path, recursive }))).toEqual([
      { path: '/proj/tests', recursive: false },
      { path: '/proj/src/nested', recursive: false },
    ])
    expect(logs.length).toBe(1)
  })

  test('a change under a fallback directory still schedules a refresh', async () => {
    const fake = createFakeWatch({ failRecursive: true })
    const { watcher, changes } = createHarness({ fake })
    watcher.updateListedFiles(['/proj/tests/a.test.ts'])

    findCall(fake.calls, '/proj/tests')?.emit('change', 'a.test.ts')
    await sleepPastDebounce()

    expect(changes.count).toBe(1)
  })
})

describe('createTestFileWatcher root-set updates', () => {
  test('a successful listing adds only new directories and reuses existing watches', () => {
    const fake = createFakeWatch()
    const { watcher } = createHarness({ fake })

    watcher.updateListedFiles(['/proj/tests/a.test.ts'])
    watcher.updateListedFiles(['/proj/tests/a.test.ts', '/proj/tests/b.test.ts'])
    expect(fake.calls.filter((call) => call.path === '/proj/tests')).toHaveLength(1)

    watcher.updateListedFiles(['/proj/tests/a.test.ts', '/proj/other/c.test.ts'])
    expect(fake.calls.filter((call) => call.path === '/proj/other')).toHaveLength(1)
    expect(fake.calls.filter((call) => call.path === '/proj/tests')).toHaveLength(1)
  })

  test('closes watches for directories no longer listed', () => {
    const fake = createFakeWatch()
    const { watcher } = createHarness({ fake })

    watcher.updateListedFiles(['/proj/tests/a.test.ts'])
    watcher.updateListedFiles(['/proj/other/c.test.ts'])

    expect(findCall(fake.calls, '/proj/tests')?.closed).toBe(true)
    expect(findCall(fake.calls, '/proj/other')?.closed).toBe(false)
  })

  test('never double-watches a directory already covered by an active recursive root', () => {
    const fake = createFakeWatch()
    const { watcher } = createHarness({ fake })

    watcher.updateListedFiles(['/proj/tests/unit/b.test.ts'])
    watcher.updateListedFiles(['/proj/tests/a.test.ts', '/proj/tests/unit/b.test.ts'])

    expect(fake.calls.filter((call) => call.path === '/proj/tests')).toHaveLength(1)
    expect(fake.calls.filter((call) => call.path === '/proj/tests/unit')).toHaveLength(1)
    expect(findCall(fake.calls, '/proj/tests/unit')?.closed).toBe(true)
  })

  test('with the non-recursive fallback, a listed descendant still gets its own watch', () => {
    const fake = createFakeWatch({ failRecursive: true })
    const { watcher } = createHarness({ fake })

    watcher.updateListedFiles(['/proj/tests/unit/b.test.ts'])
    watcher.updateListedFiles(['/proj/tests/a.test.ts', '/proj/tests/unit/b.test.ts'])

    expect(findCall(fake.calls, '/proj/tests')?.recursive).toBe(false)
    expect(findCall(fake.calls, '/proj/tests/unit')?.closed).toBe(false)
  })
})

describe('createTestFileWatcher dispose', () => {
  test('closes every handle and cancels queued work', async () => {
    const fake = createFakeWatch()
    const { watcher, changes } = createHarness({ fake })
    watcher.updateListedFiles(['/proj/tests/a.test.ts'])

    findCall(fake.calls, '/proj/tests')?.emit('change', 'a.test.ts')
    watcher.dispose()
    await sleepPastDebounce()

    expect(changes.count).toBe(0)
    expect(fake.calls.every((call) => call.closed)).toBe(true)
  })
})
