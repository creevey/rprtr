import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import { WebSocketServer } from 'ws'

import { BrowserPinValidationError, resolveProjectPins } from '../src/browser-pins'
import { CrvyRprtr, type ReporterSeams } from '../src/reporter'

const CHROMIUM_1217 = '/caches/ms-playwright/chromium-1217/chrome-mac/Chromium'
const CHROMIUM_1290 = '/caches/ms-playwright/chromium-1290/chrome-mac/Chromium'

const MANIFEST = {
  browsers: [{ name: 'chromium', revision: '1217', browserVersion: '147.0.7727.15', installByDefault: true }],
}

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function createFixtureProject(
  manifest: unknown = MANIFEST,
): Promise<{ dir: string; configFile: string; seams: ReporterSeams }> {
  const dir = await mkdtemp(join(tmpdir(), 'crvy-pins-'))
  tempDirs.push(dir)
  const coreDir = join(dir, 'node_modules', 'playwright-core')
  const testDir = join(dir, 'node_modules', '@playwright', 'test')
  await mkdir(coreDir, { recursive: true })
  await mkdir(testDir, { recursive: true })
  await writeFile(join(dir, 'package.json'), '{}')
  await writeFile(join(coreDir, 'package.json'), JSON.stringify({ name: 'playwright-core', version: '1.59.0' }))
  await writeFile(join(coreDir, 'browsers.json'), JSON.stringify(manifest))
  await writeFile(join(testDir, 'package.json'), JSON.stringify({ name: '@playwright/test', version: '1.59.0' }))
  return {
    dir,
    configFile: join(dir, 'playwright.config.ts'),
    seams: { browserTypes: { chromium: { executablePath: (): string => CHROMIUM_1217 } } },
  }
}

function configFor(
  configFile: string,
  projects: Array<{ name?: string; metadata?: unknown; use?: unknown }>,
  metadata?: unknown,
): object {
  return {
    configFile,
    rootDir: join(configFile, '..'),
    metadata,
    projects: projects.map((project) => ({ name: '', metadata: {}, use: {}, ...project })),
  }
}

function suiteStub(): object {
  return { allTests: () => [] }
}

// bun's default per-test timeout is 5 s, so a waitFor budget above it can never
// be reached: the test would die at bun's limit and report a bare timeout
// instead of waitFor's own message.
setDefaultTimeout(30000)

// The budget is generous because the assertion is about payload content, not
// latency; when the condition is reachable it is met in milliseconds. It is not
// a tolerance for a loaded runner — the CI failures that looked like slowness
// were a reporter in offline mode that never sent the message at all.
async function waitFor(condition: () => boolean, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (condition()) return
    await Bun.sleep(25)
  }
  throw new Error('waitFor timed out')
}

describe('reporter browser pins', () => {
  test('register payload carries the resolved environments', async () => {
    const { dir, configFile, seams } = await createFixtureProject()
    const received: Array<{ type: string; data: Record<string, unknown> }> = []
    const wss = new WebSocketServer({ port: 0 })
    wss.on('connection', (ws) => {
      ws.on('message', (raw) => {
        received.push(JSON.parse((raw as Buffer).toString()) as { type: string; data: Record<string, unknown> })
      })
    })
    const address = wss.address()
    if (address === null || typeof address === 'string') throw new Error('unexpected pipe address')

    try {
      const reporter = new CrvyRprtr(
        // ci: false is load-bearing. It defaults to isCI(), and an offline
        // reporter never sends register — so on any CI runner this test waited
        // for a message that was never going to come.
        { serverUrl: `ws://127.0.0.1:${address.port}`, screenshotDir: join(dir, 'shots'), ci: false },
        seams,
      )
      reporter.onBegin(
        configFor(configFile, [
          {
            name: 'chromium',
            metadata: { crvyRprtr: { browser: 'chromium', version: '147' } },
            use: { browserName: 'chromium' },
          },
        ]) as never,
        suiteStub() as never,
      )

      await waitFor(() => received.some((message) => message.type === 'register'))
      await reporter.onEnd({ status: 'passed' } as never)

      const register = received.find((message) => message.type === 'register')
      expect(register?.data.environments).toEqual({
        chromium: {
          playwrightVersion: '1.59.0',
          browser: 'chromium',
          browserVersion: '147.0.7727.15',
          revision: '1217',
          pin: { browser: 'chromium', version: '147' },
          status: 'pinned',
        },
      })
    } finally {
      wss.close()
    }
  })

  test('offline reports carry environments in the run-end event', async () => {
    const { dir, configFile, seams } = await createFixtureProject()
    const offlineReportPath = join(dir, 'crvy-rprtr-0.json')
    const reporter = new CrvyRprtr(
      {
        ci: true,
        screenshotDir: join(dir, 'shots'),
        offlineReportPath,
        reportHtmlPath: join(dir, 'crvy-rprtr.html'),
      },
      seams,
    )
    reporter.onBegin(
      configFor(configFile, [
        {
          name: 'chromium',
          metadata: { crvyRprtr: { browser: 'chromium', version: '147' } },
          use: { browserName: 'chromium' },
        },
      ]) as never,
      suiteStub() as never,
    )
    await reporter.onEnd({ status: 'passed' } as never)

    const report = JSON.parse(await readFile(offlineReportPath, 'utf8')) as {
      events: Array<{ type: string; data: Record<string, unknown> }>
    }
    const runEnd = report.events.find((event) => event.type === 'run-end')
    expect(runEnd?.data.environments).toEqual({
      chromium: {
        playwrightVersion: '1.59.0',
        browser: 'chromium',
        browserVersion: '147.0.7727.15',
        revision: '1217',
        pin: { browser: 'chromium', version: '147' },
        status: 'pinned',
      },
    })
  })

  test('invalid pin fails reporter initialization naming project and value', async () => {
    const { configFile, seams } = await createFixtureProject()
    const reporter = new CrvyRprtr({ ci: true }, seams)

    expect(() =>
      reporter.onBegin(
        configFor(configFile, [
          { name: 'chromium', metadata: { crvyRprtr: { browser: 'chromium', version: 'latest' } } },
        ]) as never,
        suiteStub() as never,
      ),
    ).toThrow(/chromium.*latest/)
  })

  test('fail policy fails init on drift with project, pin, effective build, and remedy', async () => {
    const driftManifest = {
      browsers: [{ name: 'chromium', revision: '1290', browserVersion: '149.0.7827.55', installByDefault: true }],
    }
    const { configFile } = await createFixtureProject(driftManifest)
    const reporter = new CrvyRprtr(
      { ci: true, browserPinPolicy: 'fail' },
      { browserTypes: { chromium: { executablePath: (): string => CHROMIUM_1290 } } },
    )

    expect(() =>
      reporter.onBegin(
        configFor(configFile, [
          {
            name: 'chromium',
            metadata: { crvyRprtr: { browser: 'chromium', version: '147' } },
            use: { browserName: 'chromium' },
          },
        ]) as never,
        suiteStub() as never,
      ),
    ).toThrow(/chromium@147.*149\.0\.7827\.55.*browsers resolve/s)
  })

  test('warn policy keeps a drifting run going', async () => {
    const { configFile, seams } = await createFixtureProject()
    const reporter = new CrvyRprtr(
      { ci: true, browserPinPolicy: 'warn' },
      { browserTypes: { chromium: { executablePath: (): string => CHROMIUM_1217 } } },
    )

    expect(() =>
      reporter.onBegin(
        configFor(configFile, [
          {
            name: 'chromium',
            metadata: { crvyRprtr: { browser: 'chromium', version: '149' } },
            use: { browserName: 'chromium' },
          },
        ]) as never,
        suiteStub() as never,
      ),
    ).not.toThrow()
    void seams
  })

  test('fail policy never fails unverifiable or unpinned projects', async () => {
    const { configFile, seams } = await createFixtureProject()
    const reporter = new CrvyRprtr({ ci: true, browserPinPolicy: 'fail' }, seams)

    expect(() =>
      reporter.onBegin(
        configFor(configFile, [
          {
            name: 'chrome-channel',
            metadata: { crvyRprtr: { browser: 'chromium', version: '147' } },
            use: { browserName: 'chromium', channel: 'chrome' },
          },
          { name: 'plain', metadata: {}, use: { browserName: 'chromium' } },
        ]) as never,
        suiteStub() as never,
      ),
    ).not.toThrow()
  })
})

describe('resolveProjectPins', () => {
  test('reads a pin from project metadata', () => {
    const projects = resolveProjectPins({
      configMetadata: undefined,
      projects: [
        {
          name: 'chromium',
          metadata: { crvyRprtr: { browser: 'chromium', version: '147' } },
          use: { browserName: 'chromium' },
        },
      ],
    })

    expect(projects).toEqual([
      {
        projectName: 'chromium',
        browser: 'chromium',
        pin: { browser: 'chromium', version: '147' },
      },
    ])
  })

  test('config-root pin applies to projects without their own pin', () => {
    const projects = resolveProjectPins({
      configMetadata: { crvyRprtr: { browser: 'firefox', version: '148.0' } },
      projects: [{ name: 'firefox', metadata: {}, use: { browserName: 'firefox' } }],
    })

    expect(projects[0]?.pin).toEqual({ browser: 'firefox', version: '148.0' })
  })

  test('project pin overrides the config-root pin', () => {
    const projects = resolveProjectPins({
      configMetadata: { crvyRprtr: { browser: 'firefox', version: '148.0' } },
      projects: [
        {
          name: 'chromium',
          metadata: { crvyRprtr: { browser: 'chromium', version: '147' } },
          use: { browserName: 'chromium' },
        },
      ],
    })

    expect(projects[0]?.pin).toEqual({ browser: 'chromium', version: '147' })
  })

  test('an unnamed project falls back to the configured browser as its name', () => {
    const projects = resolveProjectPins({
      configMetadata: undefined,
      projects: [{ name: '', metadata: {}, use: { browserName: 'webkit' } }],
    })

    expect(projects[0]?.projectName).toBe('webkit')
    expect(projects[0]?.browser).toBe('webkit')
    expect(projects[0]?.pin).toBeUndefined()
  })

  test('captures channel and explicit executable from project use', () => {
    const projects = resolveProjectPins({
      configMetadata: undefined,
      projects: [
        {
          name: 'chrome-channel',
          metadata: { crvyRprtr: { browser: 'chromium', version: '147' } },
          use: { browserName: 'chromium', channel: 'chrome', launchOptions: { executablePath: '/opt/chrome' } },
        },
      ],
    })

    expect(projects[0]?.channel).toBe('chrome')
    expect(projects[0]?.launchExecutablePath).toBe('/opt/chrome')
  })

  test('rejects an empty version, naming the project and value', () => {
    expect(() =>
      resolveProjectPins({
        configMetadata: undefined,
        projects: [
          {
            name: 'chromium',
            metadata: { crvyRprtr: { browser: 'chromium', version: '' } },
            use: { browserName: 'chromium' },
          },
        ],
      }),
    ).toThrow(BrowserPinValidationError)
    expect(() =>
      resolveProjectPins({
        configMetadata: undefined,
        projects: [
          {
            name: 'chromium',
            metadata: { crvyRprtr: { browser: 'chromium', version: '' } },
            use: { browserName: 'chromium' },
          },
        ],
      }),
    ).toThrow(/chromium.*""/)
  })

  test('rejects a non-numeric segment and a moving tag', () => {
    for (const version of ['147.x', 'latest']) {
      expect(() =>
        resolveProjectPins({
          configMetadata: undefined,
          projects: [
            {
              name: 'chromium',
              metadata: { crvyRprtr: { browser: 'chromium', version } },
              use: { browserName: 'chromium' },
            },
          ],
        }),
      ).toThrow(new RegExp(`chromium.*${version}`))
    }
  })

  test('rejects an unknown browser name', () => {
    expect(() =>
      resolveProjectPins({
        configMetadata: undefined,
        projects: [
          {
            name: 'opera-project',
            metadata: { crvyRprtr: { browser: 'opera', version: '147' } },
            use: { browserName: 'chromium' },
          },
        ],
      }),
    ).toThrow(/opera-project.*opera/)
  })

  test('rejects a pin whose browser conflicts with the project browser', () => {
    expect(() =>
      resolveProjectPins({
        configMetadata: undefined,
        projects: [
          {
            name: 'firefox-project',
            metadata: { crvyRprtr: { browser: 'chromium', version: '147' } },
            use: { browserName: 'firefox' },
          },
        ],
      }),
    ).toThrow(/firefox-project.*chromium.*firefox/)
  })

  test('ignores unrelated metadata keys', () => {
    const projects = resolveProjectPins({
      configMetadata: { other: true },
      projects: [{ name: 'chromium', metadata: { unrelated: 1 }, use: { browserName: 'chromium' } }],
    })

    expect(projects[0]?.pin).toBeUndefined()
  })
})
