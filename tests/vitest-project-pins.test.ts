import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { pathToFileURL } from 'url'

import type { VitestBrowserProjectLike } from '../src/vitest-pins'
import { readVitestProjectPins, type VitestConfigInstanceLike } from '../src/vitest-project-pins'

const REPO_ROOT = join(import.meta.dir, '..')

const PIN_147 = { browser: 'chromium', version: '147' } as const
const PIN_148 = { browser: 'firefox', version: '148' } as const
const PIN_WEBKIT = { browser: 'webkit', version: '26.4' } as const

interface BrowserProjectOverrides {
  name?: string
  root?: string
  engine?: string
  provider?: string
  wsEndpoint?: string
}

function browserProject(overrides: BrowserProjectOverrides = {}): VitestBrowserProjectLike {
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
            ...(overrides.wsEndpoint === undefined ? {} : { connectOptions: { wsEndpoint: overrides.wsEndpoint } }),
          },
        },
      },
    },
  }
}

interface FixtureInstanceInput {
  projects?: readonly VitestBrowserProjectLike[]
  reporters?: readonly unknown[]
  close?: () => Promise<void>
  onProjects?: () => never
}

function fixtureInstance(input: FixtureInstanceInput): VitestConfigInstanceLike {
  const close = input.close ?? ((): Promise<void> => Promise.resolve())
  const onProjects = input.onProjects
  if (onProjects !== undefined) {
    return {
      config: { reporters: input.reporters ?? [] },
      get projects(): readonly VitestBrowserProjectLike[] {
        return onProjects()
      },
      close,
    }
  }
  return { config: { reporters: input.reporters ?? [] }, projects: input.projects ?? [], close }
}

function pinDeclaringReporter(options: { browserPin?: unknown; browserPins?: unknown }): unknown {
  return { declaredPinOptions: (): unknown => options }
}

const tempDirs: string[] = []

/**
 * Vite's CJS config loader only compiles the bundled config when the require
 * hook's filename equals `realpath(fileName)`. A symlinked temp root (e.g.
 * `/var` -> `/private/var` on macOS) silently loads the raw TS config instead,
 * so fixtures must live under a realpath'd root to exercise config bundling.
 */
async function tempFixtureDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(await realpath(tmpdir()), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('readVitestProjectPins', () => {
  test('an injected loader yields per-project pins with keyed and fallback declarations', async () => {
    const pins = await readVitestProjectPins('/proj', {
      load: () =>
        Promise.resolve(
          fixtureInstance({
            reporters: [pinDeclaringReporter({ browserPin: PIN_147, browserPins: { mobile: PIN_148 } })],
            projects: [
              browserProject({ name: 'desktop', engine: 'chromium' }),
              browserProject({ name: 'mobile', engine: 'firefox' }),
            ],
          }),
        ),
      warn: () => undefined,
    })

    expect(pins).toEqual([
      { projectName: 'desktop', browser: 'chromium', pin: { browser: 'chromium', version: '147' } },
      { projectName: 'mobile', browser: 'firefox', pin: { browser: 'firefox', version: '148' } },
    ])
  })

  test('an unmatched browserPins key comes back as an invalid pin', async () => {
    const pins = await readVitestProjectPins('/proj', {
      load: () =>
        Promise.resolve(
          fixtureInstance({
            reporters: [pinDeclaringReporter({ browserPins: { 'tablet (webkit)': PIN_WEBKIT } })],
            projects: [browserProject({ name: 'desktop', engine: 'chromium' })],
          }),
        ),
      warn: () => undefined,
    })

    expect(pins).toHaveLength(2)
    expect(pins[1]).toMatchObject({
      projectName: 'tablet (webkit)',
      browser: 'webkit',
      pin: { browser: 'webkit', version: '26.4' },
    })
    expect(pins[1]?.invalidReason).toMatch(/no browser-enabled project/i)
  })

  test('a non-playwright provider comes back unverifiable', async () => {
    const pins = await readVitestProjectPins('/proj', {
      load: () =>
        Promise.resolve(
          fixtureInstance({
            reporters: [pinDeclaringReporter({ browserPin: PIN_147 })],
            projects: [browserProject({ name: 'desktop', provider: 'webdriverio' })],
          }),
        ),
      warn: () => undefined,
    })

    expect(pins[0]?.unverifiable).toBe(true)
  })

  test('an unresolvable vitest/node yields no pins and one diagnostic', async () => {
    const dir = await tempFixtureDir('crvy-vitest-project-pins-missing-')
    await writeFile(join(dir, 'package.json'), '{}')
    const warnings: string[] = []

    const pins = await readVitestProjectPins(dir, { warn: (message) => warnings.push(message) })

    expect(pins).toEqual([])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/vitest/i)
  })

  test('a throwing config load yields no pins, one diagnostic, and closes the instance', async () => {
    const closes: number[] = []
    const warnings: string[] = []
    const pins = await readVitestProjectPins('/proj', {
      load: () =>
        Promise.resolve(
          fixtureInstance({
            onProjects: (): never => {
              throw new Error('config exploded')
            },
            close: () => {
              closes.push(1)
              return Promise.resolve()
            },
          }),
        ),
      warn: (message) => warnings.push(message),
    })

    expect(pins).toEqual([])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('config exploded')
    expect(closes).toHaveLength(1)
  })
})

const FIXTURE_CONFIG = `import { playwright } from '@vitest/browser-playwright'
import { defineConfig } from 'vitest/config'
import { CrvyRprtrVitestReporter } from ${JSON.stringify(pathToFileURL(join(REPO_ROOT, 'dist', 'vitest.js')).href)}

export default defineConfig({
  test: {
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      instances: [{ browser: 'chromium', name: 'desktop' }],
    },
    reporters: [
      'default',
      new CrvyRprtrVitestReporter({
        ci: true,
        browserPins: { desktop: { browser: 'chromium', version: '147' } },
      }),
    ],
  },
})
`

describe('readVitestProjectPins through the project’s own Vitest', () => {
  test('evaluates a fixture config and returns its declared pins', async () => {
    const dir = await tempFixtureDir('crvy-vitest-project-pins-')
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'fixture', private: true }))
    await symlink(join(REPO_ROOT, 'node_modules'), join(dir, 'node_modules'), 'dir')
    await writeFile(join(dir, 'vitest.config.ts'), FIXTURE_CONFIG)
    await mkdir(join(dir, 'tests'), { recursive: true })
    await writeFile(
      join(dir, 'tests', 'example.test.ts'),
      `import { test, expect } from 'vitest'\ntest('noop', () => expect(1).toBe(1))\n`,
    )
    const warnings: string[] = []

    const pins = await readVitestProjectPins(dir, { warn: (message) => warnings.push(message) })

    expect(warnings).toEqual([])
    expect(pins).toEqual([
      {
        projectName: 'desktop',
        browser: 'chromium',
        pin: { browser: 'chromium', version: '147' },
      },
    ])
  })
})
