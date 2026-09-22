import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import type { PinBrowser, ResolvedProjectPin } from '../src/browser-pins'
import { diagnoseDockerHostServices, type HostServiceProbe } from '../src/server/docker-host-services'
import { createDockerLauncher } from '../src/server/docker-launcher'
import { assertDockerPinsSatisfied } from '../src/server/docker-preflight'
import type { DockerExec, DockerExecResult } from '../src/server/docker-support'
import {
  RunController,
  type ChildProcessLike,
  type RunContext,
  type RunControllerDeps,
} from '../src/server/run-controller'

const IMAGE = 'mcr.microsoft.com/playwright:v1.59.0-noble'
const ENDPOINT = 'ws://127.0.0.1:49153/'
const CHROMIUM_1217 = '/caches/ms-playwright/chromium-1217/chrome-mac/Chromium'
const CHROMIUM_1290 = '/caches/ms-playwright/chromium-1290/chrome-mac/Chromium'
const FIREFOX_1511 = '/caches/ms-playwright/firefox-1511/firefox/firefox'
const WEBKIT_2272 = '/caches/ms-playwright/webkit-2272/pw_run.sh'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function createFixtureProject(
  manifest: unknown = {
    browsers: [{ name: 'chromium', revision: '1217', browserVersion: '147.0.7727.15', installByDefault: true }],
  },
): Promise<{ cwd: string; ctx: RunContext }> {
  const dir = await mkdtemp(join(tmpdir(), 'crvy-docker-preflight-'))
  tempDirs.push(dir)
  const coreDir = join(dir, 'node_modules', 'playwright-core')
  const testDir = join(dir, 'node_modules', '@playwright', 'test')
  await mkdir(coreDir, { recursive: true })
  await mkdir(testDir, { recursive: true })
  await writeFile(join(dir, 'package.json'), '{}')
  await writeFile(join(coreDir, 'package.json'), JSON.stringify({ name: 'playwright-core', version: '1.59.0' }))
  await writeFile(join(coreDir, 'browsers.json'), JSON.stringify(manifest))
  await writeFile(join(testDir, 'package.json'), JSON.stringify({ name: '@playwright/test', version: '1.59.0' }))
  const configFile = join(dir, 'playwright.config.ts')
  return { cwd: dir, ctx: { configFile, cwd: dir } }
}

const PINNED_CHROMIUM_147: ResolvedProjectPin = {
  projectName: 'chromium',
  browser: 'chromium',
  pin: { browser: 'chromium', version: '147' },
}

function fakeExec(script: Array<{ match: string[]; result: DockerExecResult }>): {
  exec: DockerExec
  calls: string[][]
} {
  const calls: string[][] = []
  const exec: DockerExec = (args) => {
    calls.push(args)
    const entry = script.find((s) => s.match.every((m, i) => args[i] === m))
    if (entry === undefined)
      return Promise.resolve({ exitCode: 1, stdout: '', stderr: `unexpected: ${args.join(' ')}` })
    return Promise.resolve(entry.result)
  }
  return { exec, calls }
}

const ok: DockerExecResult = { exitCode: 0, stdout: '', stderr: '' }

describe('docker pin preflight', () => {
  test('rejects a drifting run before any container starts, naming the image tag', async () => {
    const { cwd, ctx } = await createFixtureProject({
      browsers: [{ name: 'chromium', revision: '1290', browserVersion: '149.0.7827.55', installByDefault: true }],
    })
    const { exec, calls } = fakeExec([{ match: ['info'], result: ok }])

    const launcher = createDockerLauncher({
      port: 3000,
      exec,
      getPlaywrightVersion: () => '1.59.0',
      readProjectPins: () => Promise.resolve([PINNED_CHROMIUM_147]),
      browserExecutablePaths: { chromium: CHROMIUM_1290 },
    })

    const error = await launcher.prepare!({ ctx, onProgress: () => undefined })
      .then(() => null)
      .catch((reason: unknown) => (reason instanceof Error ? reason : new Error(String(reason))))

    expect(error).not.toBeNull()
    expect(error!.message).toContain(IMAGE)
    expect(error!.message).toContain('chromium@147')
    expect(error!.message).toContain('149.0.7827.55')
    // No container started and no image pulled.
    expect(calls.some((args) => args[0] === 'run')).toBe(false)
    expect(calls.some((args) => args[0] === 'pull')).toBe(false)
    void cwd
  })

  test('proceeds with a satisfied pin and records the image in the launch env', async () => {
    const { ctx } = await createFixtureProject()
    const { exec, calls } = fakeExec([
      { match: ['info'], result: ok },
      { match: ['image', 'inspect', IMAGE], result: ok },
    ])

    const launcher = createDockerLauncher({
      port: 3000,
      exec,
      getPlaywrightVersion: () => '1.59.0',
      readProjectPins: () => Promise.resolve([PINNED_CHROMIUM_147]),
      browserExecutablePaths: { chromium: CHROMIUM_1217 },
    })

    await launcher.prepare!({ ctx, onProgress: () => undefined })
    const spec = launcher.launch({ ctx, playwrightArgs: ['test'] })

    expect(calls.some((args) => args[0] === 'image')).toBe(true)
    expect(spec.args).toContain(`CRVY_RPRTR_DOCKER_IMAGE=${IMAGE}`)
  })

  test('projects without pins skip the preflight', async () => {
    const { ctx } = await createFixtureProject()
    const { exec } = fakeExec([
      { match: ['info'], result: ok },
      { match: ['image', 'inspect', IMAGE], result: ok },
    ])

    const launcher = createDockerLauncher({
      port: 3000,
      exec,
      getPlaywrightVersion: () => '1.59.0',
      readProjectPins: () => Promise.resolve([{ projectName: 'chromium', browser: 'chromium' }]),
      browserExecutablePaths: { chromium: CHROMIUM_1290 },
    })

    await launcher.prepare!({ ctx, onProgress: () => undefined })
  })

  test('unverifiable pins never reject a docker run', async () => {
    const { ctx } = await createFixtureProject()
    const { exec } = fakeExec([
      { match: ['info'], result: ok },
      { match: ['image', 'inspect', IMAGE], result: ok },
    ])

    const launcher = createDockerLauncher({
      port: 3000,
      exec,
      getPlaywrightVersion: () => '1.59.0',
      readProjectPins: () =>
        Promise.resolve([
          {
            projectName: 'chrome-channel',
            browser: 'chromium',
            pin: { browser: 'chromium', version: '147' },
            channel: 'chrome',
          },
        ]),
      browserExecutablePaths: { chromium: CHROMIUM_1290 },
    })

    await launcher.prepare!({ ctx, onProgress: () => undefined })
  })
})

describe('docker config preflight', () => {
  const SUMMARY = {
    webServers: [
      { command: 'npm run storybook', url: 'http://localhost:6006', name: 'storybook', reuseExistingServer: true },
      { command: 'npm run api', port: 4000 },
    ],
    projects: [{ name: 'chromium', baseURL: 'http://localhost:6006' }],
  }
  const noopWarn = (): void => undefined

  test('returns the resolved config summary alongside the pins', async () => {
    const { ctx } = await createFixtureProject()

    const result = await assertDockerPinsSatisfied({
      cwd: ctx.cwd,
      image: IMAGE,
      warn: noopWarn,
      readProjectPins: () => Promise.resolve([]),
      readConfigSummary: () => Promise.resolve(SUMMARY),
    })

    expect(result).toEqual(SUMMARY)
  })

  test('a failed config summary read degrades to null without warning or blocking', async () => {
    const warnings: string[] = []

    const result = await assertDockerPinsSatisfied({
      cwd: '/proj',
      image: IMAGE,
      warn: (message) => warnings.push(message),
      readProjectPins: () => Promise.resolve([]),
      readConfigSummary: () => Promise.reject(new Error('config exploded')),
    })

    expect(result).toBeNull()
    expect(warnings).toEqual([])
  })

  test('a summary survives a pin-read failure so diagnostics still run', async () => {
    const warnings: string[] = []

    const result = await assertDockerPinsSatisfied({
      cwd: '/proj',
      image: IMAGE,
      warn: (message) => warnings.push(message),
      readProjectPins: () => Promise.reject(new Error('config exploded')),
      readConfigSummary: () => Promise.resolve(SUMMARY),
    })

    expect(result).toEqual(SUMMARY)
    expect(warnings.join('\n')).toContain('config exploded')
  })
})

describe('host service diagnostic', () => {
  const unreachable: HostServiceProbe = {
    http: () => Promise.resolve(null),
    tcp: () => Promise.resolve(false),
  }

  test('warns when a loopback webServer with reuse intent is masked inside the container', async () => {
    const notices = await diagnoseDockerHostServices({
      config: {
        webServers: [{ command: 'npm run storybook', url: 'http://localhost:6006', reuseExistingServer: true }],
        projects: [],
      },
      probe: { http: () => Promise.resolve(200) },
    })

    expect(notices).toHaveLength(1)
    expect(notices[0]).toContain('http://localhost:6006')
    expect(notices[0]).toContain('npm run storybook')
    expect(notices[0]).toContain('CRVY_RPRTR_HOST_GATEWAY')
    expect(notices[0]).toContain('docs/docker-host-services.md')
  })

  test('names the array entry that will be masked', async () => {
    const notices = await diagnoseDockerHostServices({
      config: {
        webServers: [
          { command: 'npm run api', port: 4000, reuseExistingServer: true },
          { command: 'npm run storybook', name: 'storybook', url: 'http://localhost:6006', reuseExistingServer: true },
        ],
        projects: [],
      },
      probe: { http: () => Promise.resolve(200), tcp: () => Promise.resolve(true) },
    })

    expect(notices).toHaveLength(2)
    const storybook = notices.find((notice) => notice.includes('storybook'))
    expect(storybook).toBeDefined()
    expect(storybook).toContain('http://localhost:6006')
    expect(storybook).toContain('npm run storybook')
  })

  test('warns for an uncovered loopback baseURL whose host service answers', async () => {
    const notices = await diagnoseDockerHostServices({
      config: { webServers: [], projects: [{ name: 'chromium', baseURL: 'http://127.0.0.1:5173' }] },
      probe: { http: () => Promise.resolve(200) },
    })

    expect(notices).toHaveLength(1)
    expect(notices[0]).toContain('http://127.0.0.1:5173')
    expect(notices[0]).toContain('CRVY_RPRTR_HOST_GATEWAY')
  })

  test('judges a baseURL served by a webServer entry by that entry and warns once', async () => {
    const notices = await diagnoseDockerHostServices({
      config: {
        webServers: [{ command: 'npm run dev', url: 'http://localhost:6006', reuseExistingServer: true }],
        projects: [{ name: 'chromium', baseURL: 'http://localhost:6006' }],
      },
      probe: { http: () => Promise.resolve(200) },
    })

    expect(notices).toHaveLength(1)
    expect(notices[0]).toContain('npm run dev')
  })

  test('warns when nothing serves a host-gateway address', async () => {
    const notices = await diagnoseDockerHostServices({
      config: { webServers: [], projects: [{ name: 'chromium', baseURL: 'http://host.docker.internal:6006' }] },
      probe: unreachable,
    })

    expect(notices).toHaveLength(1)
    expect(notices[0]).toContain('http://host.docker.internal:6006')
    expect(notices[0]).toContain('fail or time out')
    expect(notices[0]).toContain('docs/docker-host-services.md')
  })

  test('does not warn without divergence', async () => {
    // A loopback webServer without reuse intent: Playwright starts its own server in-container.
    const withoutIntent = await diagnoseDockerHostServices({
      config: {
        webServers: [{ command: 'npm run dev', url: 'http://localhost:6006' }],
        projects: [{ name: 'chromium', baseURL: 'http://localhost:6006' }],
      },
      probe: { http: () => Promise.resolve(200) },
    })

    // A gateway address whose service answers on the host.
    const served = await diagnoseDockerHostServices({
      config: {
        webServers: [{ command: 'npm run dev', url: 'http://host.docker.internal:6006', reuseExistingServer: true }],
        projects: [{ name: 'chromium', baseURL: 'http://host.docker.internal:6006' }],
      },
      probe: { http: () => Promise.resolve(200) },
    })

    expect(withoutIntent).toEqual([])
    expect(served).toEqual([])
  })

  test('produces nothing for an unresolvable config and never probes', async () => {
    const probed: string[] = []
    const notices = await diagnoseDockerHostServices({
      config: null,
      probe: {
        http: (url) => {
          probed.push(url)
          return Promise.resolve(200)
        },
        tcp: (host, port) => {
          probed.push(`${host}:${port}`)
          return Promise.resolve(true)
        },
      },
    })

    const malformed = await diagnoseDockerHostServices({
      config: { webServers: [{ command: 'npm run dev', url: 'not-a-url' }], projects: [{ name: 'p', baseURL: ':::' }] },
      probe: unreachable,
    })

    expect(notices).toEqual([])
    expect(malformed).toEqual([])
    expect(probed).toEqual([])
  })

  test('counts a 404-at-root server answering /index.html as available', async () => {
    const probed: string[] = []
    const notices = await diagnoseDockerHostServices({
      config: { webServers: [], projects: [{ name: 'chromium', baseURL: 'http://host.docker.internal:6006' }] },
      probe: {
        http: (url) => {
          probed.push(url)
          return Promise.resolve(url.endsWith('/index.html') ? 200 : 404)
        },
      },
    })

    expect(notices).toEqual([])
    expect(probed).toContain('http://host.docker.internal:6006/index.html')
  })

  test('falls back to the loopback alias when the gateway hostname does not answer', async () => {
    const probed: string[] = []
    const notices = await diagnoseDockerHostServices({
      config: { webServers: [], projects: [{ name: 'chromium', baseURL: 'http://host.docker.internal:6006' }] },
      probe: {
        http: (url) => {
          probed.push(url)
          return Promise.resolve(url.includes('localhost') ? 200 : null)
        },
      },
    })

    expect(notices).toEqual([])
    expect(probed).toEqual(['http://host.docker.internal:6006/', 'http://localhost:6006/'])
  })

  test('strips credentials and tokens from warned addresses', async () => {
    const notices = await diagnoseDockerHostServices({
      config: {
        webServers: [
          {
            command: 'npm run dev',
            url: 'http://dev:secret@localhost:6006/?token=abc#frag',
            reuseExistingServer: true,
          },
        ],
        projects: [],
      },
      probe: { http: () => Promise.resolve(200) },
    })

    expect(notices).toHaveLength(1)
    expect(notices[0]).toContain('http://localhost:6006')
    expect(notices[0]).not.toContain('secret')
    expect(notices[0]).not.toContain('token')
  })
})

interface VitestPreflightFixture {
  controller: RunController
  ensureCalls: { value: number }
  warnings: string[]
}

function createVitestPreflightFixture(input: {
  ctx: RunContext
  readVitestPins?: (cwd: string) => Promise<readonly ResolvedProjectPin[]>
  browserExecutablePaths?: (cwd: string) => Record<PinBrowser, string> | null
}): VitestPreflightFixture {
  const ensureCalls = { value: 0 }
  const warnings: string[] = []
  const child: ChildProcessLike = {
    on: (): void => undefined,
    kill: (): void => undefined,
  }
  const deps: RunControllerDeps = {
    getRunContext: () => input.ctx,
    port: 3000,
    broadcast: (): void => undefined,
    setReportRunning: (): void => undefined,
    spawn: () => child,
    timers: { setTimeout: () => 0, clearTimeout: (): void => undefined },
    launcher: {
      mode: 'docker',
      launch: () => ({ cmd: 'npx', args: ['vitest', 'run'], env: {} }),
    },
    getRunMode: () => 'docker',
    hasBrowserHook: () => true,
    browserSidecar: {
      endpoint: ENDPOINT,
      image: IMAGE,
      resolveImage: () => IMAGE,
      ensure: () => {
        ensureCalls.value += 1
        return Promise.resolve(ENDPOINT)
      },
      dispose: (): void => undefined,
    },
    ...(input.readVitestPins === undefined ? {} : { readVitestPins: input.readVitestPins }),
    ...(input.browserExecutablePaths === undefined ? {} : { browserExecutablePaths: input.browserExecutablePaths }),
    warn: (message) => warnings.push(message),
  }
  return { controller: new RunController(deps), ensureCalls, warnings }
}

const ALL_EXECUTABLE_PATHS: Record<PinBrowser, string> = {
  chromium: CHROMIUM_1217,
  firefox: FIREFOX_1511,
  webkit: WEBKIT_2272,
}

describe('Vitest docker pin preflight', () => {
  test('rejects a drifting Vitest pin before sidecar.ensure, naming the image tag', async () => {
    const { ctx } = await createFixtureProject()
    const f = createVitestPreflightFixture({
      ctx: { ...ctx, runner: 'vitest', configFile: join(ctx.cwd, 'vitest.config.ts') },
      readVitestPins: () =>
        Promise.resolve([
          { projectName: 'desktop', browser: 'chromium', pin: { browser: 'chromium', version: '149' } },
        ]),
      browserExecutablePaths: () => ALL_EXECUTABLE_PATHS,
    })

    expect(await f.controller.prepareRun()).toEqual({ ok: false, reason: 'docker-unavailable' })
    expect(f.ensureCalls.value).toBe(0)
    expect(f.warnings.join('\n')).toContain(IMAGE)
    expect(f.warnings.join('\n')).toContain('chromium@149')
  })

  test('unpinned and unverifiable Vitest pins pass', async () => {
    const { ctx } = await createFixtureProject()
    const vitestCtx: RunContext = { ...ctx, runner: 'vitest', configFile: join(ctx.cwd, 'vitest.config.ts') }
    const pins = [
      { projectName: 'plain', browser: 'chromium' },
      {
        projectName: 'remote',
        browser: 'chromium',
        pin: { browser: 'chromium', version: '147' },
        unverifiable: true,
      },
    ] satisfies ResolvedProjectPin[]
    const f = createVitestPreflightFixture({
      ctx: vitestCtx,
      readVitestPins: () => Promise.resolve(pins),
      browserExecutablePaths: () => ALL_EXECUTABLE_PATHS,
    })

    expect(await f.controller.prepareRun()).toEqual({ ok: true })
    expect(f.ensureCalls.value).toBe(1)
    expect(f.warnings).toEqual([])
  })

  test('a reader failure only warns and never blocks the run', async () => {
    const { ctx } = await createFixtureProject()
    const f = createVitestPreflightFixture({
      ctx: { ...ctx, runner: 'vitest', configFile: join(ctx.cwd, 'vitest.config.ts') },
      readVitestPins: () => Promise.reject(new Error('config exploded')),
      browserExecutablePaths: () => ALL_EXECUTABLE_PATHS,
    })

    expect(await f.controller.prepareRun()).toEqual({ ok: true })
    expect(f.ensureCalls.value).toBe(1)
    expect(f.warnings.join('\n')).toContain('config exploded')
  })
})
