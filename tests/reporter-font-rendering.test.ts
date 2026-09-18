import { describe, expect, test } from 'bun:test'

import { rootFontconfigPath } from '../src/fontconfig'
import { CrvyRprtr, type ReporterSeams } from '../src/reporter'
import type { CrvyRprtrOptions } from '../src/reporter-helpers'

const PINNED_PATH = '/tmp/crvy-rprtr/fonts.conf'

interface Harness {
  env: Record<string, string | undefined>
  logs: string[]
}

function construct(options: CrvyRprtrOptions = {}, seams: Partial<ReporterSeams> = {}, env = {}): Harness {
  const harness: Harness = { env: { ...env }, logs: [] }
  const reporter = new CrvyRprtr(
    { ci: true, ...options },
    {
      browserTypes: {
        chromium: { executablePath: (): string => '/chromium' },
        firefox: { executablePath: (): string => '/firefox' },
        webkit: { executablePath: (): string => '/webkit' },
      },
      env: harness.env,
      log: (message: string): void => void harness.logs.push(message),
      fontconfig: { platform: 'linux', exists: (): boolean => true, writeConfig: (): string => PINNED_PATH },
      ...seams,
    },
  )
  expect(reporter).toBeDefined()
  return harness
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
