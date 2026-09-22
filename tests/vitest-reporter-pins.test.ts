import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import { WebSocketServer, type WebSocket } from 'ws'

import { BrowserPinValidationError } from '../src/browser-pins'
import type { ProjectEnvironment, RunEnvironments } from '../src/browser-pins'
import { CrvyRprtrVitestReporter } from '../src/vitest'
import type { CrvyRprtrVitestReporterOptions } from '../src/vitest-options'

interface FixtureManifestEntry {
  name: string
  revision: string
  browserVersion: string
  installByDefault?: boolean
}

interface FixtureManifest {
  browsers: FixtureManifestEntry[]
}

const PINNED_MANIFEST: FixtureManifest = {
  browsers: [{ name: 'chromium', revision: '1217', browserVersion: '147.0.7727.15', installByDefault: true }],
}

const DRIFT_MANIFEST: FixtureManifest = {
  browsers: [{ name: 'chromium', revision: '1290', browserVersion: '149.0.7827.55', installByDefault: true }],
}

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function createFixtureProject(manifest: FixtureManifest = PINNED_MANIFEST): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'crvy-vitest-reporter-pins-'))
  tempDirs.push(dir)
  const coreDir = join(dir, 'node_modules', 'playwright-core')
  const playwrightDir = join(dir, 'node_modules', 'playwright')
  await mkdir(coreDir, { recursive: true })
  await mkdir(playwrightDir, { recursive: true })
  await writeFile(join(dir, 'package.json'), '{}')
  await writeFile(join(coreDir, 'package.json'), JSON.stringify({ name: 'playwright-core', version: '1.59.0' }))
  await writeFile(join(coreDir, 'browsers.json'), JSON.stringify(manifest))
  await writeFile(
    join(playwrightDir, 'package.json'),
    JSON.stringify({ name: 'playwright', version: '1.59.0', main: 'index.js' }),
  )
  const revision = manifest.browsers.find((browser) => browser.name === 'chromium')?.revision ?? '1217'
  const executablePath = `/caches/ms-playwright/chromium-${revision}/chrome-mac/Chromium`
  await writeFile(
    join(playwrightDir, 'index.js'),
    `module.exports = { chromium: { executablePath: () => ${JSON.stringify(executablePath)} } }\n`,
  )
  return dir
}

function mockProject(root: string, name: string, engine: string): unknown {
  return {
    name,
    config: {
      root,
      attachmentsDir: join(root, '.vitest-attachments'),
      browser: { name: engine, screenshotDirectory: '__screenshots__', provider: { name: 'playwright', options: {} } },
    },
  }
}

function mockVitest(root: string, projects: unknown[]): unknown {
  return {
    config: { root, configFile: join(root, 'vitest.config.ts'), reporters: [] },
    vite: { config: { configFile: join(root, 'vitest.config.ts') } },
    projects,
  }
}

/** Runs the reporter offline and returns the environments carried by the run-end event. */
async function runOffline(
  root: string,
  projects: unknown[],
  options: CrvyRprtrVitestReporterOptions = {},
): Promise<RunEnvironments | undefined> {
  const offlineReportPath = join(root, 'crvy-rprtr-0.json')
  const reporter = new CrvyRprtrVitestReporter({
    ci: true,
    screenshotDir: join(root, 'shots'),
    offlineReportPath,
    reportHtmlPath: join(root, 'crvy-rprtr.html'),
    ...options,
  })
  reporter.onInit(mockVitest(root, projects) as never)
  reporter.onBrowserInit?.(projects[0] as never)
  await reporter.onTestRunEnd?.([], [], 'passed')

  const report = JSON.parse(await readFile(offlineReportPath, 'utf8')) as {
    events: Array<{ type: string; data: Record<string, unknown> }>
  }
  return report.events.find((event) => event.type === 'run-end')?.data.environments as RunEnvironments | undefined
}

interface WsHarness {
  close: () => void
  port: number
  received: Array<{ type: string; data: Record<string, unknown> }>
  waitForCount: (count: number) => Promise<void>
}

function startWsServer(): WsHarness {
  const received: Array<{ type: string; data: Record<string, unknown> }> = []
  const wss = new WebSocketServer({ port: 0 })
  wss.on('connection', (ws: WebSocket) => {
    ws.on('message', (raw) => {
      received.push(JSON.parse((raw as Buffer).toString()) as { type: string; data: Record<string, unknown> })
    })
  })
  const address = wss.address()
  if (address === null || typeof address === 'string') throw new Error('unexpected ws address')
  return {
    close: (): void => wss.close(),
    port: address.port,
    received,
    waitForCount: async (count: number): Promise<void> => {
      const deadline = Date.now() + 3000
      while (Date.now() < deadline) {
        if (received.length >= count) return
        await Bun.sleep(25)
      }
      throw new Error(`waitForCount(${count}) timed out; received ${received.length}`)
    },
  }
}

let warnCalls: string[] = []
let warnRestore: () => void = () => undefined

beforeEach(() => {
  warnCalls = []
  const spy = spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    warnCalls.push(args.map(String).join(' '))
  })
  warnRestore = (): void => spy.mockRestore()
})

afterEach(() => {
  warnRestore()
})

const PINNED_ENVIRONMENT: ProjectEnvironment = {
  playwrightVersion: '1.59.0',
  browser: 'chromium',
  browserVersion: '147.0.7727.15',
  revision: '1217',
  pin: { browser: 'chromium', version: '147' },
  status: 'pinned',
}

describe('CrvyRprtrVitestReporter browser pins', () => {
  test('register payload carries environments keyed by project name', async () => {
    const root = await createFixtureProject()
    const harness = startWsServer()

    try {
      const reporter = new CrvyRprtrVitestReporter({
        serverUrl: `ws://127.0.0.1:${harness.port}`,
        screenshotDir: join(root, 'shots'),
        browserPin: { browser: 'chromium', version: '147' },
      })
      reporter.onInit(
        mockVitest(root, [
          mockProject(root, 'desktop (chromium)', 'chromium'),
          mockProject(root, 'mobile', 'chromium'),
        ]) as never,
      )
      reporter.onBrowserInit?.(mockProject(root, 'desktop (chromium)', 'chromium') as never)
      await harness.waitForCount(1)

      const register = harness.received.find((message) => message.type === 'register')
      expect(register?.data.environments).toEqual({
        'desktop (chromium)': PINNED_ENVIRONMENT,
        mobile: PINNED_ENVIRONMENT,
      })
    } finally {
      harness.close()
    }
  })

  test('run-end payload carries environments in offline mode', async () => {
    const root = await createFixtureProject()
    const environments = await runOffline(root, [mockProject(root, 'desktop (chromium)', 'chromium')], {
      browserPins: { 'desktop (chromium)': { browser: 'chromium', version: '147' } },
    })

    expect(environments).toEqual({ 'desktop (chromium)': PINNED_ENVIRONMENT })
  })

  test('an unpinned browser project is recorded unpinned', async () => {
    const root = await createFixtureProject()
    const environments = await runOffline(root, [mockProject(root, 'desktop (chromium)', 'chromium')])

    expect(environments?.['desktop (chromium)']?.status).toBe('unpinned')
    expect(environments?.['desktop (chromium)']?.browserVersion).toBe('147.0.7727.15')
  })

  test('the fail policy throws at onInit with project, pin, effective build, and remedy', async () => {
    const root = await createFixtureProject(DRIFT_MANIFEST)
    const reporter = new CrvyRprtrVitestReporter({
      ci: true,
      browserPin: { browser: 'chromium', version: '147' },
      browserPinPolicy: 'fail',
    })

    expect(() =>
      reporter.onInit(mockVitest(root, [mockProject(root, 'desktop (chromium)', 'chromium')]) as never),
    ).toThrow(/desktop \(chromium\).*chromium@147.*149\.0\.7827\.55.*browsers resolve/s)
  })

  test('the warn policy logs once and the run proceeds', async () => {
    const root = await createFixtureProject(DRIFT_MANIFEST)
    const environments = await runOffline(root, [mockProject(root, 'desktop (chromium)', 'chromium')], {
      browserPin: { browser: 'chromium', version: '147' },
      browserPinPolicy: 'warn',
    })

    expect(environments?.['desktop (chromium)']?.status).toBe('drift')
    expect(warnCalls).toHaveLength(1)
    expect(warnCalls[0]).toContain('desktop (chromium)')
    expect(warnCalls[0]).toContain('chromium@147')
  })

  test('an unmatched key warns once and the fallback still applies', async () => {
    const root = await createFixtureProject()
    const environments = await runOffline(root, [mockProject(root, 'desktop (chromium)', 'chromium')], {
      browserPin: { browser: 'chromium', version: '147' },
      browserPins: { 'mobile (webkit)': { browser: 'webkit', version: '26.4' } },
    })

    expect(environments?.['desktop (chromium)']).toEqual(PINNED_ENVIRONMENT)
    expect(warnCalls).toHaveLength(1)
    expect(warnCalls[0]).toContain('mobile (webkit)')
    expect(warnCalls[0]).toContain('desktop (chromium)')
  })

  test('an invalid pin throws at initialization naming the option', async () => {
    const root = await createFixtureProject()
    const reporter = new CrvyRprtrVitestReporter({
      ci: true,
      browserPin: { browser: 'chromium', version: 'latest' },
    })

    expect(() =>
      reporter.onInit(mockVitest(root, [mockProject(root, 'desktop (chromium)', 'chromium')]) as never),
    ).toThrow(BrowserPinValidationError)
    expect(() =>
      reporter.onInit(mockVitest(root, [mockProject(root, 'desktop (chromium)', 'chromium')]) as never),
    ).toThrow(/browserPin.*latest/)
  })

  test('declaredPinOptions exposes the declared pin options for the CLI reader', () => {
    const reporter = new CrvyRprtrVitestReporter({
      ci: true,
      browserPin: { browser: 'chromium', version: '147' },
      browserPins: { mobile: { browser: 'webkit', version: '26.4' } },
    })

    expect(reporter.declaredPinOptions()).toEqual({
      browserPin: { browser: 'chromium', version: '147' },
      browserPins: { mobile: { browser: 'webkit', version: '26.4' } },
    })
  })
})
