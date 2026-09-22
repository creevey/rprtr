import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'fs'
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { createRequire } from 'module'
import { tmpdir } from 'os'
import { join } from 'path'

import { readPlaywrightListWithConfig } from '../src/project-pins'
import { DOCKER_CONFIG_DUMP_ENV, ensureConfigDumpReporter, readAndDeleteConfigDump } from '../src/server/config-dump'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  Reflect.deleteProperty(process.env, DOCKER_CONFIG_DUMP_ENV)
})

interface DumpReporterInstance {
  version?: () => string
  onConfigure: (config: unknown) => void
}

type DumpReporterConstructor = new () => DumpReporterInstance

function loadDumpReporter(): DumpReporterConstructor {
  // Mirrors Playwright's own CJS reporter loading of the generated file.
  const require = createRequire(import.meta.url)
  return require(ensureConfigDumpReporter()) as DumpReporterConstructor
}

async function dumpPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'crvy-config-dump-'))
  tempDirs.push(dir)
  return join(dir, 'dump.json')
}

async function runReporter(config: unknown): Promise<Record<string, unknown> | null> {
  const target = await dumpPath()
  process.env[DOCKER_CONFIG_DUMP_ENV] = target
  try {
    ;new (loadDumpReporter())().onConfigure(config)
  } finally {
    Reflect.deleteProperty(process.env, DOCKER_CONFIG_DUMP_ENV)
  }
  if (!existsSync(target)) return null
  return JSON.parse(await readFile(target, 'utf8')) as Record<string, unknown>
}

/** Fixture for Playwright's internal config carrier: `config[configInternalSymbol]`. */
function internalConfig(webServers: unknown[]): Record<symbol, unknown> {
  return { [Symbol('configInternalSymbol')]: { webServers } }
}

describe('config dump reporter', () => {
  test('declares the v2 reporter version', () => {
    const reporter = new (loadDumpReporter())()
    expect(reporter.version?.()).toBe('v2')
  })

  test('writes the resolved webServers and project baseURLs', async () => {
    const dump = await runReporter({
      webServer: { command: 'npm run dev', url: 'http://localhost:6006', reuseExistingServer: true },
      projects: [
        { name: 'chromium', use: { baseURL: 'http://localhost:6006' } },
        { name: 'firefox', use: { baseURL: 'http://localhost:6006' } },
      ],
    })

    expect(dump).toEqual({
      webServers: [{ command: 'npm run dev', url: 'http://localhost:6006', reuseExistingServer: true }],
      projects: [
        { name: 'chromium', baseURL: 'http://localhost:6006' },
        { name: 'firefox', baseURL: 'http://localhost:6006' },
      ],
    })
  })

  test('reads array-form webServers through the internal config symbol', async () => {
    const dump = await runReporter({
      webServer: null,
      projects: [],
      ...internalConfig([
        { command: 'npm run storybook', url: 'http://localhost:6006', reuseExistingServer: true, name: 'storybook' },
        { command: 'npm run api', port: 4000 },
      ]),
    })

    expect(dump).toEqual({
      webServers: [
        { command: 'npm run storybook', url: 'http://localhost:6006', name: 'storybook', reuseExistingServer: true },
        { command: 'npm run api', port: 4000 },
      ],
      projects: [],
    })
  })

  test('omits fields the config does not declare', async () => {
    const dump = await runReporter({
      webServer: { command: 'npm run dev' },
      projects: [{ name: 'chromium', use: {} }, { use: { baseURL: 'http://localhost:3000' } }, {}],
    })

    expect(dump).toEqual({
      webServers: [{ command: 'npm run dev' }],
      projects: [{ name: 'chromium' }, { baseURL: 'http://localhost:3000' }],
    })
  })

  test('never throws on a malformed config and writes what it can', async () => {
    const configs: unknown[] = [
      null,
      {},
      { webServer: 'not-an-object', projects: 'not-an-array' },
      { webServer: {}, projects: [null, 42] },
      { projects: [{ use: 'not-an-object' }] },
      internalConfig([null, 42]),
      { webServer: { command: 42, url: null }, projects: [{ name: 7, use: { baseURL: 8 } }] },
    ]

    for (const config of configs) {
      expect(() => new (loadDumpReporter())().onConfigure(config)).not.toThrow()
    }
    expect(await runReporter({ webServer: 'not-an-object', projects: 'not-an-array' })).toEqual({
      webServers: [],
      projects: [],
    })
  })

  test('never throws when the dump target is not writable', () => {
    const Reporter = loadDumpReporter()
    process.env[DOCKER_CONFIG_DUMP_ENV] = join(tmpdir(), 'crvy-rprtr-missing-dir', 'nested', 'dump.json')
    try {
      expect(() => new Reporter().onConfigure({})).not.toThrow()
    } finally {
      Reflect.deleteProperty(process.env, DOCKER_CONFIG_DUMP_ENV)
    }
  })

  test('writes nothing without the dump path in the environment', async () => {
    const target = await dumpPath()
    Reflect.deleteProperty(process.env, DOCKER_CONFIG_DUMP_ENV)
    ;new (loadDumpReporter())().onConfigure({ webServer: { command: 'npm run dev' } })
    expect(existsSync(target)).toBe(false)
  })
})

describe('readAndDeleteConfigDump', () => {
  test('parses a valid dump and deletes the file', async () => {
    const target = await dumpPath()
    await writeFile(target, JSON.stringify({ webServers: [{ url: 'http://localhost:6006' }], projects: [] }))

    expect(readAndDeleteConfigDump(target)).toEqual({
      webServers: [{ url: 'http://localhost:6006' }],
      projects: [],
    })
    expect(existsSync(target)).toBe(false)
  })

  test('returns null and cleans up for a missing or malformed dump', async () => {
    const missing = join(tmpdir(), 'crvy-rprtr-does-not-exist', 'dump.json')
    expect(readAndDeleteConfigDump(missing)).toBeNull()

    const malformed = await dumpPath()
    await writeFile(malformed, 'not json')
    expect(readAndDeleteConfigDump(malformed)).toBeNull()
    expect(existsSync(malformed)).toBe(false)

    const wrongShape = await dumpPath()
    await writeFile(wrongShape, JSON.stringify({ webServers: 'nope', projects: [] }))
    expect(readAndDeleteConfigDump(wrongShape)).toBeNull()
    expect(existsSync(wrongShape)).toBe(false)
  })
})

describe('config dump integration', () => {
  test("lists a real array-form webServer through the project's own Playwright", async () => {
    const fixtureDir = join(import.meta.dir, 'fixtures', 'webserver-array')
    const { report, config } = await readPlaywrightListWithConfig(fixtureDir, {
      configFile: join(fixtureDir, 'playwright.config.ts'),
    })

    // The JSON list report cannot see either: arrays become null and baseURL is absent.
    expect(report).not.toBeNull()
    expect(config).toEqual({
      webServers: [
        {
          command: 'node -e "setInterval(() => {}, 1000)"',
          name: 'storybook',
          url: 'http://localhost:65111',
          reuseExistingServer: true,
        },
        { command: 'node -e "setInterval(() => {}, 1000)"', port: 65112 },
      ],
      projects: [{ name: 'chromium', baseURL: 'http://localhost:65111' }],
    })
  }, 30_000)
})
