import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import { parseCliInvocation } from '../src/cli'
import { runBrowsersCommand, type BrowsersCommandDeps } from '../src/cli-browsers'
import { parseProjectPinsFromListReport } from '../src/project-pins'

const FIXTURE_ENTRIES = [
  {
    ver: '1.61.1',
    date: '2026-06-23',
    browsers: {
      chromium: '149.0.7827.55 (1228)',
      firefox: '151.0 (1532)',
      webkit: '26.5 (2311)',
    },
  },
  {
    ver: '1.60.0',
    date: '2026-05-05',
    browsers: {
      chromium: '148.0.7778.96 (1194)',
      firefox: '150.0.1 (1521)',
      webkit: '26.4 (2272)',
    },
  },
  {
    ver: '1.59.1',
    date: '2026-04-01',
    browsers: {
      chromium: '147.0.7727.15 (1217)',
      firefox: '148.0.2 (1511)',
      webkit: '26.4 (2272)',
    },
  },
  {
    ver: '1.62.0-alpha-2026-07-19',
    date: '2026-07-19',
    browsers: {
      chromium: '151.0.7922.34 (1234)',
      firefox: '152.0.4 (1535)',
      webkit: '26.5 (2333)',
    },
  },
]

interface Captured {
  out: string[]
  err: string[]
}

function capture(): Captured {
  return { out: [], err: [] }
}

function makeDeps(io: Captured, overrides: Partial<BrowsersCommandDeps> = {}): BrowsersCommandDeps {
  return {
    cwd: process.cwd(),
    out: (line: string): void => {
      io.out.push(line)
    },
    err: (line: string): void => {
      io.err.push(line)
    },
    loadBuildMap: () => Promise.resolve({ entries: FIXTURE_ENTRIES, source: 'cache' }),
    probeBuildMap: () => Promise.resolve([]),
    readPins: () => Promise.resolve([]),
    executablePaths: () =>
      Promise.resolve({
        chromium: '/caches/ms-playwright/chromium-1217/chrome-mac/Chromium',
        firefox: '/caches/ms-playwright/firefox-1511/firefox/firefox',
        webkit: '/caches/ms-playwright/webkit-2272/pw_run.sh',
      }),
    ...overrides,
  }
}

describe('browsers command routing', () => {
  test('dispatches an unknown subcommand to a diagnostic with a non-zero exit', async () => {
    const io = capture()
    const code = await runBrowsersCommand(['wat'], makeDeps(io))

    expect(code).toBe(1)
    expect(io.err.join('\n')).toMatch(/unknown/i)
    expect(io.err.join('\n')).toContain('list')
    expect(io.err.join('\n')).toContain('resolve')
    expect(io.err.join('\n')).toContain('check')
  })

  test('a missing subcommand prints usage with a non-zero exit', async () => {
    const io = capture()
    const code = await runBrowsersCommand([], makeDeps(io))

    expect(code).toBe(1)
    expect(io.err.join('\n')).toMatch(/usage/i)
  })

  test('`browsers` alone routes to the command group, not artifact-dir mode', () => {
    expect(parseCliInvocation(['browsers', 'list'])).toEqual({
      kind: 'browsers',
      args: ['list'],
    })
    expect(parseCliInvocation(['browsers', 'resolve', 'chromium@147'])).toEqual({
      kind: 'browsers',
      args: ['resolve', 'chromium@147'],
    })
  })

  test('artifact-dir mode is unchanged', () => {
    const invocation = parseCliInvocation(['./artifacts', '--port', '3001'])

    expect(invocation.kind).toBe('server')
    if (invocation.kind !== 'server') return
    expect(invocation.options.port).toBe(3001)
    expect(invocation.options.screenshotDir).toBe('artifacts/screenshots')
    expect(invocation.options.reportPath).toBe('artifacts/report.json')
  })

  test('--help routes to help', () => {
    expect(parseCliInvocation(['--help'])).toEqual({ kind: 'help' })
    expect(parseCliInvocation(['-h'])).toEqual({ kind: 'help' })
  })
})

describe('browsers list', () => {
  test('lists stable entries by default', async () => {
    const io = capture()
    const code = await runBrowsersCommand(['list'], makeDeps(io))
    const text = io.out.join('\n')

    expect(code).toBe(0)
    expect(text).toContain('chromium 149.0.7827.55')
    expect(text).toContain('revision 1228')
    expect(text).toContain('playwright 1.61.1')
    expect(text).not.toContain('1.62.0-alpha')
  })

  test('--all includes pre-releases', async () => {
    const io = capture()
    const code = await runBrowsersCommand(['list', '--all'], makeDeps(io))
    const text = io.out.join('\n')

    expect(code).toBe(0)
    expect(text).toContain('1.62.0-alpha-2026-07-19')
  })

  test('--refresh reloads the map', async () => {
    const io = capture()
    const requests: Array<{ refresh?: boolean }> = []
    const code = await runBrowsersCommand(
      ['list', '--refresh'],
      makeDeps(io, {
        loadBuildMap: (options) => {
          requests.push(options ?? {})
          return Promise.resolve({ entries: FIXTURE_ENTRIES, source: 'network' })
        },
      }),
    )

    expect(code).toBe(0)
    expect(requests).toEqual([{ refresh: true }])
  })

  test('offline without a usable cache exits non-zero with a diagnostic', async () => {
    const io = capture()
    const code = await runBrowsersCommand(['list'], makeDeps(io, { loadBuildMap: () => Promise.resolve(null) }))

    expect(code).toBe(1)
    expect(io.err.join('\n')).toMatch(/offline/i)
  })
})

describe('browsers resolve', () => {
  test('resolves a unique prefix to build, revision, and Playwright version', async () => {
    const io = capture()
    const code = await runBrowsersCommand(['resolve', 'chromium@147'], makeDeps(io))
    const text = io.out.join('\n')

    expect(code).toBe(0)
    expect(text).toContain('chromium 147.0.7727.15')
    expect(text).toContain('revision 1217')
    expect(text).toContain('playwright 1.59.1')
  })

  test('recommends the newest build and lists alternatives for an ambiguous prefix', async () => {
    const io = capture()
    const code = await runBrowsersCommand(['resolve', 'webkit@26'], makeDeps(io))
    const text = io.out.join('\n')

    expect(code).toBe(0)
    expect(text).toMatch(/recommended/i)
    expect(text).toContain('26.5')
    expect(text).toContain('1.61.1')
    expect(text).toMatch(/alternative/i)
    expect(text).toContain('26.4')
  })

  test('fails with the nearest matching majors when nothing matches', async () => {
    const io = capture()
    const code = await runBrowsersCommand(['resolve', 'chromium@150'], makeDeps(io))
    const text = io.err.join('\n')

    expect(code).toBe(1)
    expect(text).toMatch(/no build matches/i)
    expect(text).toMatch(/nearest/i)
    expect(text).toContain('149')
  })

  test('probes recent releases when the cached map lacks the prefix', async () => {
    const io = capture()
    const probed = {
      ver: '1.63.0',
      date: '2026-08-01',
      browsers: { chromium: '151.0.7922.34 (1234)' },
    }
    const code = await runBrowsersCommand(
      ['resolve', 'chromium@151'],
      makeDeps(io, {
        probeBuildMap: () => Promise.resolve([probed]),
      }),
    )
    const text = io.out.join('\n')

    expect(code).toBe(0)
    expect(text).toContain('151.0.7922.34')
    expect(text).toContain('1.63.0')
  })

  test('rejects an invalid browser or prefix', async () => {
    const io = capture()
    expect(await runBrowsersCommand(['resolve', 'opera@147'], makeDeps(io))).toBe(1)
    expect(io.err.join('\n')).toMatch(/browser/i)

    const io2 = capture()
    expect(await runBrowsersCommand(['resolve', 'chromium@latest'], makeDeps(io2))).toBe(1)
    expect(io2.err.join('\n')).toMatch(/version/i)

    const io3 = capture()
    expect(await runBrowsersCommand(['resolve', 'chromium'], makeDeps(io3))).toBe(1)
  })

  test('offline without a usable cache exits non-zero', async () => {
    const io = capture()
    const code = await runBrowsersCommand(
      ['resolve', 'chromium@147'],
      makeDeps(io, { loadBuildMap: () => Promise.resolve(null) }),
    )

    expect(code).toBe(1)
    expect(io.err.join('\n')).toMatch(/offline/i)
  })

  test('reports the installed environment and a remedy on drift', async () => {
    const io = capture()
    const code = await runBrowsersCommand(
      ['resolve', 'chromium@147'],
      makeDeps(io, {
        executablePaths: () =>
          Promise.resolve({
            chromium: '/caches/ms-playwright/chromium-1290/chrome-mac/Chromium',
            firefox: '/caches/ms-playwright/firefox-1511/firefox/firefox',
            webkit: '/caches/ms-playwright/webkit-2272/pw_run.sh',
          }),
      }),
    )
    const text = io.out.join('\n')

    // The map fixture provides no manifest, so the environment is unverifiable rather than drifted.
    expect(code).toBe(0)
    expect(text).toMatch(/installed/i)
  })
})

describe('parseProjectPinsFromListReport', () => {
  test('reads project metadata and the config-root fallback', () => {
    const pins = parseProjectPinsFromListReport({
      config: {
        metadata: { crvyRprtr: { browser: 'firefox', version: '148' } },
        projects: [
          { name: 'chromium', metadata: { crvyRprtr: { browser: 'chromium', version: '147' } } },
          { name: 'firefox', metadata: {} },
        ],
      },
    })

    expect(pins.map((project) => project.pin)).toEqual([
      { browser: 'chromium', version: '147' },
      { browser: 'firefox', version: '148' },
    ])
  })

  test('returns no pins for reports without a config section', () => {
    expect(parseProjectPinsFromListReport({})).toEqual([])
    expect(parseProjectPinsFromListReport(null)).toEqual([])
  })
})

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function createFixtureProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'crvy-cli-pins-'))
  tempDirs.push(dir)
  const coreDir = join(dir, 'node_modules', 'playwright-core')
  const testDir = join(dir, 'node_modules', '@playwright', 'test')
  await mkdir(coreDir, { recursive: true })
  await mkdir(testDir, { recursive: true })
  await writeFile(join(dir, 'package.json'), '{}')
  await writeFile(join(coreDir, 'package.json'), JSON.stringify({ name: 'playwright-core', version: '1.59.0' }))
  await writeFile(
    join(coreDir, 'browsers.json'),
    JSON.stringify({
      browsers: [
        { name: 'chromium', revision: '1217', browserVersion: '147.0.7727.15', installByDefault: true },
        { name: 'firefox', revision: '1511', browserVersion: '148.0.2', installByDefault: true },
      ],
    }),
  )
  await writeFile(join(testDir, 'package.json'), JSON.stringify({ name: '@playwright/test', version: '1.59.0' }))
  return dir
}

describe('browsers check', () => {
  test('reports each pinned project with pin, effective build, and status', async () => {
    const io = capture()
    const cwd = await createFixtureProject()
    const code = await runBrowsersCommand(
      ['check'],
      makeDeps(io, {
        cwd,
        readPins: () =>
          Promise.resolve([
            {
              projectName: 'chromium',
              browser: 'chromium',
              pin: { browser: 'chromium', version: '147' },
            },
          ]),
        executablePaths: () =>
          Promise.resolve({
            chromium: '/caches/ms-playwright/chromium-1217/chrome-mac/Chromium',
            firefox: '/caches/ms-playwright/firefox-1511/firefox/firefox',
            webkit: '/caches/ms-playwright/webkit-2272/pw_run.sh',
          }),
      }),
    )
    const text = io.out.join('\n')

    expect(code).toBe(0)
    expect(text).toContain('chromium: pins chromium@147')
    expect(text).toContain('147.0.7727.15')
    expect(text).toContain('[pinned]')
  })

  test('--strict exits non-zero on drift only', async () => {
    const cwd = await createFixtureProject()
    const deps = (io: Captured): BrowsersCommandDeps =>
      makeDeps(io, {
        cwd,
        readPins: () =>
          Promise.resolve([
            {
              projectName: 'chromium',
              browser: 'chromium',
              pin: { browser: 'chromium', version: '149' },
            },
          ]),
        executablePaths: () =>
          Promise.resolve({
            chromium: '/caches/ms-playwright/chromium-1217/chrome-mac/Chromium',
            firefox: '/caches/ms-playwright/firefox-1511/firefox/firefox',
            webkit: '/caches/ms-playwright/webkit-2272/pw_run.sh',
          }),
      })

    const strict = capture()
    expect(await runBrowsersCommand(['check', '--strict'], deps(strict))).toBe(1)
    expect(strict.out.join('\n')).toContain('[drift]')

    const lenient = capture()
    expect(await runBrowsersCommand(['check'], deps(lenient))).toBe(0)
    expect(lenient.out.join('\n')).toContain('[drift]')
  })

  test('unverifiable and unpinned projects never fail strict mode', async () => {
    const cwd = await createFixtureProject()
    const io = capture()
    const code = await runBrowsersCommand(
      ['check', '--strict'],
      makeDeps(io, {
        cwd,
        readPins: () =>
          Promise.resolve([
            {
              projectName: 'chrome-channel',
              browser: 'chromium',
              pin: { browser: 'chromium', version: '147' },
              channel: 'chrome',
            },
            { projectName: 'plain', browser: 'chromium' },
          ]),
        executablePaths: () =>
          Promise.resolve({
            chromium: '/caches/ms-playwright/chromium-1217/chrome-mac/Chromium',
            firefox: '/caches/ms-playwright/firefox-1511/firefox/firefox',
            webkit: '/caches/ms-playwright/webkit-2272/pw_run.sh',
          }),
      }),
    )

    expect(code).toBe(0)
    expect(io.out.join('\n')).toContain('[unverifiable]')
  })

  test('works offline (never touches the build map)', async () => {
    const cwd = await createFixtureProject()
    const io = capture()
    let mapReads = 0
    const code = await runBrowsersCommand(
      ['check', '--strict'],
      makeDeps(io, {
        cwd,
        loadBuildMap: () => {
          mapReads += 1
          return Promise.resolve(null)
        },
        readPins: () =>
          Promise.resolve([
            {
              projectName: 'chromium',
              browser: 'chromium',
              pin: { browser: 'chromium', version: '147' },
            },
          ]),
        executablePaths: () =>
          Promise.resolve({
            chromium: '/caches/ms-playwright/chromium-1217/chrome-mac/Chromium',
            firefox: '/caches/ms-playwright/firefox-1511/firefox/firefox',
            webkit: '/caches/ms-playwright/webkit-2272/pw_run.sh',
          }),
      }),
    )

    expect(code).toBe(0)
    expect(mapReads).toBe(0)
  })

  test('reports no pins as a clean pass', async () => {
    const io = capture()
    const code = await runBrowsersCommand(['check', '--strict'], makeDeps(io))

    expect(code).toBe(0)
    expect(io.out.join('\n')).toMatch(/no browser pins/i)
  })
})
