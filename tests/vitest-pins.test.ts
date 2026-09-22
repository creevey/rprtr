import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import { BrowserPinValidationError } from '../src/browser-pins'
import { resolveInstalledExecutablePath } from '../src/playwright-install'
import {
  buildVitestEnvironments,
  resolveVitestPins,
  type VitestBrowserProjectLike,
  type VitestProjectPin,
} from '../src/vitest-pins'

const CHROMIUM_1217 = '/caches/ms-playwright/chromium-1217/chrome-mac/Chromium'
const CHROMIUM_1290 = '/caches/ms-playwright/chromium-1290/chrome-mac/Chromium'
const WEBKIT_2272 = '/caches/ms-playwright/webkit-2272/pw_run.sh'

const MANIFEST = {
  browsers: [{ name: 'chromium', revision: '1217', browserVersion: '147.0.7727.15', installByDefault: true }],
}

const DRIFT_MANIFEST = {
  browsers: [{ name: 'chromium', revision: '1290', browserVersion: '149.0.7827.55', installByDefault: true }],
}

const OVERRIDE_MANIFEST = {
  browsers: [
    {
      name: 'webkit',
      revision: '2272',
      browserVersion: '26.4',
      revisionOverrides: { 'ubuntu24.04-arm64': '2274' },
      installByDefault: true,
    },
  ],
}

const PLAYWRIGHT_VERSION = '1.59.0'
const MANAGED_IMAGE = `mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-noble`
const MANAGED_ENDPOINT = 'ws://127.0.0.1:49153/'

interface VitestProjectOverrides {
  name?: string
  root?: string
  engine?: string
  provider?: string
  launchOptions?: { channel?: string; executablePath?: string }
  connectOptions?: { wsEndpoint?: string }
}

function browserProject(overrides: VitestProjectOverrides = {}): VitestBrowserProjectLike {
  const engine = overrides.engine ?? 'chromium'
  return {
    name: overrides.name ?? engine,
    config: {
      root: overrides.root ?? '/proj',
      browser: {
        name: engine,
        provider: {
          name: overrides.provider ?? 'playwright',
          options: {
            ...(overrides.launchOptions === undefined ? {} : { launchOptions: overrides.launchOptions }),
            ...(overrides.connectOptions === undefined ? {} : { connectOptions: overrides.connectOptions }),
          },
        },
      },
    },
  }
}

function resolvedProject(overrides: Partial<VitestProjectPin> = {}): VitestProjectPin {
  return {
    projectName: 'desktop (chromium)',
    browser: 'chromium',
    projectRoot: '/proj',
    provider: 'playwright',
    ...overrides,
  }
}

const PIN_147 = { browser: 'chromium', version: '147' } as const
const PIN_149 = { browser: 'chromium', version: '149' } as const

describe('resolveVitestPins', () => {
  test('applies the browserPin fallback to every browser project', () => {
    const { projects, unmatchedPins } = resolveVitestPins({
      projects: [browserProject({ name: 'desktop (chromium)' })],
      browserPin: PIN_147,
    })

    expect(projects).toEqual([
      {
        projectName: 'desktop (chromium)',
        browser: 'chromium',
        projectRoot: '/proj',
        provider: 'playwright',
        pin: { browser: 'chromium', version: '147' },
      },
    ])
    expect(unmatchedPins).toEqual([])
  })

  test('a keyed browserPins entry overrides the fallback', () => {
    const { projects } = resolveVitestPins({
      projects: [browserProject({ name: 'desktop (chromium)' }), browserProject({ name: 'mobile', engine: 'firefox' })],
      browserPin: PIN_147,
      browserPins: { mobile: { browser: 'firefox', version: '148.0' } },
    })

    expect(projects[0]?.pin).toEqual({ browser: 'chromium', version: '147' })
    expect(projects[1]?.pin).toEqual({ browser: 'firefox', version: '148.0' })
  })

  test('an unmatched key is reported instead of failing', () => {
    const { projects, unmatchedPins } = resolveVitestPins({
      projects: [browserProject({ name: 'desktop (chromium)' })],
      browserPin: PIN_147,
      browserPins: { 'mobile (webkit)': { browser: 'webkit', version: '26.4' } },
    })

    expect(projects[0]?.pin).toEqual({ browser: 'chromium', version: '147' })
    expect(unmatchedPins).toEqual([{ key: 'mobile (webkit)', pin: { browser: 'webkit', version: '26.4' } }])
  })

  test('rejects a pin whose browser disagrees with the project engine', () => {
    expect(() => resolveVitestPins({ projects: [browserProject({ engine: 'firefox' })], browserPin: PIN_147 })).toThrow(
      BrowserPinValidationError,
    )
    expect(() => resolveVitestPins({ projects: [browserProject({ engine: 'firefox' })], browserPin: PIN_147 })).toThrow(
      /firefox.*chromium.*firefox/,
    )
  })

  test('rejects an invalid fallback pin naming the option and value', () => {
    expect(() =>
      resolveVitestPins({ projects: [browserProject()], browserPin: { browser: 'chromium', version: 'latest' } }),
    ).toThrow(/browserPin.*latest/)
  })

  test('rejects an invalid keyed pin naming the key and value', () => {
    expect(() =>
      resolveVitestPins({
        projects: [browserProject({ name: 'desktop (chromium)' })],
        browserPins: { 'desktop (chromium)': { browser: 'opera', version: '147' } },
      }),
    ).toThrow(/desktop \(chromium\).*opera/)
  })

  test('skips projects that are not browser-enabled', () => {
    const { projects, unmatchedPins } = resolveVitestPins({
      projects: [
        { name: 'unit', config: { root: '/proj', browser: { name: 'node' } } },
        browserProject({ name: 'desktop (chromium)' }),
      ],
      browserPin: PIN_147,
      browserPins: { unit: { browser: 'chromium', version: '149' } },
    })

    expect(projects.map(({ projectName }) => projectName)).toEqual(['desktop (chromium)'])
    expect(unmatchedPins).toEqual([{ key: 'unit', pin: { browser: 'chromium', version: '149' } }])
  })
})

describe('buildVitestEnvironments', () => {
  test('a pinned local run resolves the manifest build', () => {
    const environments = buildVitestEnvironments({
      projects: [resolvedProject({ pin: PIN_147 })],
      manifest: MANIFEST,
      playwrightVersion: PLAYWRIGHT_VERSION,
      executablePathFor: () => CHROMIUM_1217,
    })

    expect(environments['desktop (chromium)']).toEqual({
      playwrightVersion: PLAYWRIGHT_VERSION,
      browser: 'chromium',
      browserVersion: '147.0.7727.15',
      revision: '1217',
      pin: { browser: 'chromium', version: '147' },
      status: 'pinned',
    })
  })

  test('a drifted local pin resolves drift from the injected manifest', () => {
    const environments = buildVitestEnvironments({
      projects: [resolvedProject({ pin: PIN_147 })],
      manifest: DRIFT_MANIFEST,
      playwrightVersion: PLAYWRIGHT_VERSION,
      executablePathFor: () => CHROMIUM_1290,
    })

    expect(environments['desktop (chromium)']?.status).toBe('drift')
    expect(environments['desktop (chromium)']?.browserVersion).toBe('149.0.7827.55')
  })

  test('an unpinned local project is recorded unpinned with its build', () => {
    const environments = buildVitestEnvironments({
      projects: [resolvedProject()],
      manifest: MANIFEST,
      playwrightVersion: PLAYWRIGHT_VERSION,
      executablePathFor: () => CHROMIUM_1217,
    })

    expect(environments['desktop (chromium)']?.status).toBe('unpinned')
    expect(environments['desktop (chromium)']?.browserVersion).toBe('147.0.7727.15')
  })

  test('a non-playwright provider is unverifiable', () => {
    const environments = buildVitestEnvironments({
      projects: [resolvedProject({ provider: 'webdriverio', pin: PIN_147 })],
      manifest: MANIFEST,
      playwrightVersion: PLAYWRIGHT_VERSION,
      executablePathFor: () => CHROMIUM_1217,
    })

    expect(environments['desktop (chromium)']?.status).toBe('unverifiable')
    expect(environments['desktop (chromium)']?.browserVersion).toBeNull()
  })

  test('a remote endpoint is unverifiable', () => {
    const environments = buildVitestEnvironments({
      projects: [resolvedProject({ wsEndpoint: 'ws://remote.example:3000/', pin: PIN_147 })],
      manifest: MANIFEST,
      playwrightVersion: PLAYWRIGHT_VERSION,
      executablePathFor: () => CHROMIUM_1217,
    })

    expect(environments['desktop (chromium)']?.status).toBe('unverifiable')
  })

  test('a branded channel is unverifiable', () => {
    const environments = buildVitestEnvironments({
      projects: [resolvedProject({ channel: 'chrome', pin: PIN_147 })],
      manifest: MANIFEST,
      playwrightVersion: PLAYWRIGHT_VERSION,
      executablePathFor: () => CHROMIUM_1217,
    })

    expect(environments['desktop (chromium)']?.status).toBe('unverifiable')
  })

  test('an explicit executable is unverifiable', () => {
    const environments = buildVitestEnvironments({
      projects: [resolvedProject({ launchExecutablePath: '/opt/chrome', pin: PIN_147 })],
      manifest: MANIFEST,
      playwrightVersion: PLAYWRIGHT_VERSION,
      executablePathFor: () => CHROMIUM_1217,
    })

    expect(environments['desktop (chromium)']?.status).toBe('unverifiable')
  })

  test('a custom Docker image is unverifiable', () => {
    const environments = buildVitestEnvironments({
      projects: [resolvedProject({ pin: PIN_147 })],
      manifest: MANIFEST,
      playwrightVersion: PLAYWRIGHT_VERSION,
      executablePathFor: () => CHROMIUM_1217,
      dockerImage: 'custom/img:1',
    })

    expect(environments['desktop (chromium)']?.status).toBe('unverifiable')
    expect(environments['desktop (chromium)']?.dockerImage).toBe('custom/img:1')
  })

  test('a manifest entry with revision overrides is unverifiable', () => {
    const environments = buildVitestEnvironments({
      projects: [resolvedProject({ browser: 'webkit', pin: { browser: 'webkit', version: '26.4' } })],
      manifest: OVERRIDE_MANIFEST,
      playwrightVersion: PLAYWRIGHT_VERSION,
      executablePathFor: () => WEBKIT_2272,
    })

    expect(environments['desktop (chromium)']?.status).toBe('unverifiable')
  })

  test('the managed sidecar env resolves the manifest default revision and records the image', () => {
    const environments = buildVitestEnvironments({
      projects: [resolvedProject({ wsEndpoint: MANAGED_ENDPOINT, pin: PIN_147 })],
      browserWs: MANAGED_ENDPOINT,
      dockerImage: MANAGED_IMAGE,
      manifest: MANIFEST,
      playwrightVersion: PLAYWRIGHT_VERSION,
      executablePathFor: () => {
        throw new Error('sidecar runs must not resolve a host executable')
      },
    })

    expect(environments['desktop (chromium)']).toEqual({
      playwrightVersion: PLAYWRIGHT_VERSION,
      browser: 'chromium',
      browserVersion: '147.0.7727.15',
      revision: '1217',
      dockerImage: MANAGED_IMAGE,
      pin: { browser: 'chromium', version: '147' },
      status: 'pinned',
    })
  })

  test('a sidecar run whose pin the image cannot satisfy is drift', () => {
    const environments = buildVitestEnvironments({
      projects: [resolvedProject({ wsEndpoint: MANAGED_ENDPOINT, pin: PIN_149 })],
      browserWs: MANAGED_ENDPOINT,
      dockerImage: MANAGED_IMAGE,
      manifest: MANIFEST,
      playwrightVersion: PLAYWRIGHT_VERSION,
    })

    expect(environments['desktop (chromium)']?.status).toBe('drift')
    expect(environments['desktop (chromium)']?.dockerImage).toBe(MANAGED_IMAGE)
  })

  test('a hand-set endpoint with the canonical image is still unverifiable', () => {
    const environments = buildVitestEnvironments({
      projects: [resolvedProject({ wsEndpoint: 'ws://elsewhere:1234/', pin: PIN_147 })],
      browserWs: MANAGED_ENDPOINT,
      dockerImage: MANAGED_IMAGE,
      manifest: MANIFEST,
      playwrightVersion: PLAYWRIGHT_VERSION,
    })

    expect(environments['desktop (chromium)']?.status).toBe('unverifiable')
  })
})

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

interface FixturePackages {
  playwright?: string
  playwrightTest?: string
}

async function fixtureProject(packages: FixturePackages): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'crvy-vitest-pins-'))
  tempDirs.push(dir)
  const coreDir = join(dir, 'node_modules', 'playwright-core')
  await mkdir(coreDir, { recursive: true })
  await writeFile(join(dir, 'package.json'), '{}')
  await writeFile(join(coreDir, 'package.json'), JSON.stringify({ name: 'playwright-core', version: '1.59.0' }))
  await writeFile(join(coreDir, 'browsers.json'), JSON.stringify(MANIFEST))
  if (packages.playwright !== undefined) {
    await writePackage(dir, 'playwright', packages.playwright, CHROMIUM_1217)
  }
  if (packages.playwrightTest !== undefined) {
    await writePackage(dir, '@playwright/test', packages.playwrightTest, CHROMIUM_1290)
  }
  return dir
}

async function writePackage(dir: string, name: string, version: string, executablePath: string): Promise<void> {
  const packageDir = join(dir, 'node_modules', ...name.split('/'))
  await mkdir(packageDir, { recursive: true })
  await writeFile(join(packageDir, 'package.json'), JSON.stringify({ name, version, main: 'index.js' }))
  await writeFile(
    join(packageDir, 'index.js'),
    `module.exports = { chromium: { executablePath: () => ${JSON.stringify(executablePath)} } }\n`,
  )
}

describe('resolveInstalledExecutablePath', () => {
  test("prefers the project's playwright over @playwright/test", async () => {
    const dir = await fixtureProject({ playwright: '1.59.0', playwrightTest: '1.58.0' })
    expect(resolveInstalledExecutablePath(dir, 'chromium')).toBe(CHROMIUM_1217)
  })

  test('falls back to @playwright/test when playwright is absent', async () => {
    const dir = await fixtureProject({ playwrightTest: '1.58.0' })
    expect(resolveInstalledExecutablePath(dir, 'chromium')).toBe(CHROMIUM_1290)
  })

  test('returns null when neither package is installed', async () => {
    const dir = await fixtureProject({})
    expect(resolveInstalledExecutablePath(dir, 'chromium')).toBeNull()
  })
})
