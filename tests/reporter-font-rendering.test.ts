import { describe, expect, test } from 'bun:test'

import { rootFontconfigPath } from '../src/fontconfig'
import { CrvyRprtr, type ReporterSeams } from '../src/reporter'
import type { CrvyRprtrOptions } from '../src/reporter-helpers'

const PINNED_PATH = '/tmp/crvy-rprtr/fonts.conf'

interface Harness {
  env: Record<string, string | undefined>
  logs: string[]
  reporter: CrvyRprtr
}

function construct(options: CrvyRprtrOptions = {}, seams: Partial<ReporterSeams> = {}, env = {}): Harness {
  const logs: string[] = []
  const harnessEnv: Record<string, string | undefined> = { ...env }
  const reporter = new CrvyRprtr(
    { ci: true, ...options },
    {
      browserTypes: {
        chromium: { executablePath: (): string => '/chromium' },
        firefox: { executablePath: (): string => '/firefox' },
        webkit: { executablePath: (): string => '/webkit' },
      },
      env: harnessEnv,
      log: (message: string): void => void logs.push(message),
      fontconfig: { platform: 'linux', exists: (): boolean => true, writeConfig: (): string => PINNED_PATH },
      ...seams,
    },
  )
  return { env: harnessEnv, logs, reporter }
}

describe('CrvyRprtr font rendering', () => {
  test('pins the generated fontconfig on the env every worker will inherit', () => {
    const { env, logs } = construct()
    expect(env.FONTCONFIG_FILE).toBe(PINNED_PATH)
    expect(logs).toEqual([])
  })

  test('leaves the env alone and says why on fontRendering: inherit', () => {
    const { env, logs } = construct({ fontRendering: 'inherit' })
    expect(env.FONTCONFIG_FILE).toBeUndefined()
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatch(/inherit/i)
  })

  test('leaves the env alone and says why where fontconfig does not drive rendering', () => {
    const { env, logs } = construct({}, { fontconfig: { platform: 'darwin', exists: (): boolean => true } })
    expect(env.FONTCONFIG_FILE).toBeUndefined()
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatch(/fontconfig/i)
  })

  test('leaves the env alone and says why when there is no system config to extend', () => {
    const { env, logs } = construct({}, { fontconfig: { platform: 'linux', exists: (): boolean => false } })
    expect(env.FONTCONFIG_FILE).toBeUndefined()
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatch(/system fontconfig/i)
  })

  test('says nothing when a crvy-rprtr run mode already pinned the environment', () => {
    const { env, logs } = construct({}, {}, { FONTCONFIG_FILE: rootFontconfigPath() })
    expect(env.FONTCONFIG_FILE).toBe(rootFontconfigPath())
    expect(logs).toEqual([])
  })

  test('rejects an invalid fontRendering value at reporter init', () => {
    expect(() => construct({ fontRendering: 'greyscale' } as unknown as CrvyRprtrOptions)).toThrow(/fontRendering/)
  })
})

function configWith(projects: Array<{ name: string; use?: unknown }>): object {
  return {
    configFile: '/proj/playwright.config.ts',
    rootDir: '/proj',
    metadata: {},
    projects: projects.map((project) => ({ metadata: {}, use: {}, ...project })),
  }
}

const suiteStub = { allTests: (): unknown[] => [] }

describe('CrvyRprtr launchOptions.env detection', () => {
  function beginWith(projects: Array<{ name: string; use?: unknown }>, options: CrvyRprtrOptions = {}): string[] {
    const warnings: string[] = []
    const harness = construct(options, { warn: (message: string): void => void warnings.push(message) })
    expect(harness.env).toBeDefined()
    harness.reporter.onBegin(configWith(projects) as never, suiteStub as never)
    return warnings
  }

  test('warns once, naming the project, when a project replaces the browser environment', () => {
    const warnings = beginWith([{ name: 'chromium', use: { launchOptions: { env: { MY_VAR: 'mine' } } } }])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('chromium')
    expect(warnings[0]).toMatch(/deterministicLaunchOptions/)
  })

  test('names every affected project in the one warning', () => {
    const warnings = beginWith([
      { name: 'chromium', use: { launchOptions: { env: { A: '1' } } } },
      { name: 'firefox', use: { launchOptions: { env: { B: '2' } } } },
      { name: 'webkit', use: {} },
    ])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('chromium')
    expect(warnings[0]).toContain('firefox')
    expect(warnings[0]).not.toContain('webkit')
  })

  test('does not warn when the config applies the exported helper', () => {
    expect(
      beginWith([{ name: 'chromium', use: { launchOptions: { env: { FONTCONFIG_FILE: rootFontconfigPath() } } } }]),
    ).toEqual([])
  })

  test('does not warn when no project sets a browser environment', () => {
    expect(beginWith([{ name: 'chromium', use: { launchOptions: { args: ['--no-sandbox'] } } }])).toEqual([])
  })

  test('does not warn when pinning was skipped, since nothing was dropped', () => {
    expect(
      beginWith([{ name: 'chromium', use: { launchOptions: { env: { MY_VAR: 'mine' } } } }], {
        fontRendering: 'inherit',
      }),
    ).toEqual([])
  })
})
