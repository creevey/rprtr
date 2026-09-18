import { describe, expect, test } from 'bun:test'

import { rootFontconfigPath } from '../src/fontconfig'
import {
  DETERMINISTIC_CHROMIUM_ARGS,
  applyGrayscaleFontRendering,
  deterministicChromiumLaunchOptions,
  deterministicLaunchOptions,
} from '../src/rendering'

const LINUX_SEAMS = {
  platform: 'linux' as const,
  exists: (): boolean => true,
  writeConfig: (): string => '/tmp/crvy-rprtr/fonts.conf',
}

describe('deterministicChromiumLaunchOptions', () => {
  test('adds the AA switch to an empty config', () => {
    expect(deterministicChromiumLaunchOptions().args).toEqual([...DETERMINISTIC_CHROMIUM_ARGS])
  })

  test('keeps the caller args and other launch options', () => {
    const options = deterministicChromiumLaunchOptions({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] })
    expect(options.executablePath).toBe('/usr/bin/chromium')
    expect(options.args).toEqual(['--no-sandbox', ...DETERMINISTIC_CHROMIUM_ARGS])
  })

  test('does not duplicate an arg the caller already passed', () => {
    const options = deterministicChromiumLaunchOptions({ args: [...DETERMINISTIC_CHROMIUM_ARGS] })
    expect(options.args).toEqual([...DETERMINISTIC_CHROMIUM_ARGS])
  })
})

describe('deterministicLaunchOptions', () => {
  test('points the browser process at the generated fontconfig root config', () => {
    const options = deterministicLaunchOptions({}, LINUX_SEAMS)
    expect(options.env?.FONTCONFIG_FILE).toBe('/tmp/crvy-rprtr/fonts.conf')
  })

  test('keeps the inherited environment and the caller own entries', () => {
    process.env.CRVY_TEST_INHERITED = 'inherited'
    try {
      const options = deterministicLaunchOptions({ env: { MY_VAR: 'mine' }, args: ['--no-sandbox'] }, LINUX_SEAMS)
      expect(options.env?.CRVY_TEST_INHERITED).toBe('inherited')
      expect(options.env?.MY_VAR).toBe('mine')
      expect(options.args).toEqual(['--no-sandbox'])
    } finally {
      delete process.env.CRVY_TEST_INHERITED
    }
  })

  test('adds no browser args: they would reach Chromium only', () => {
    expect(deterministicLaunchOptions({}, LINUX_SEAMS).args).toBeUndefined()
  })

  test('fontRendering: inherit returns the options untouched', () => {
    const base = { args: ['--no-sandbox'] }
    expect(deterministicLaunchOptions(base, { ...LINUX_SEAMS, fontRendering: 'inherit' })).toBe(base)
  })

  test('is a no-op where fontconfig does not apply', () => {
    const base = {}
    expect(deterministicLaunchOptions(base, { ...LINUX_SEAMS, platform: 'darwin' })).toBe(base)
    expect(deterministicLaunchOptions(base, { ...LINUX_SEAMS, exists: () => false })).toBe(base)
  })
})

describe('applyGrayscaleFontRendering', () => {
  test('pins the generated config on the passed env and reports the path', () => {
    const env: Record<string, string | undefined> = {}
    const result = applyGrayscaleFontRendering(env, LINUX_SEAMS)
    expect(result).toEqual({ pinned: true, path: '/tmp/crvy-rprtr/fonts.conf' })
    expect(env.FONTCONFIG_FILE).toBe('/tmp/crvy-rprtr/fonts.conf')
  })

  test('skips on fontRendering: inherit, leaving the env untouched', () => {
    const env: Record<string, string | undefined> = {}
    expect(applyGrayscaleFontRendering(env, { ...LINUX_SEAMS, fontRendering: 'inherit' })).toEqual({
      pinned: false,
      reason: 'inherit',
    })
    expect(env).toEqual({})
  })

  test('skips where text rendering is not fontconfig-driven', () => {
    const env: Record<string, string | undefined> = {}
    expect(applyGrayscaleFontRendering(env, { ...LINUX_SEAMS, platform: 'darwin' })).toEqual({
      pinned: false,
      reason: 'not-linux',
    })
    expect(env).toEqual({})
  })

  test('skips when there is no system config to extend', () => {
    const env: Record<string, string | undefined> = {}
    expect(applyGrayscaleFontRendering(env, { ...LINUX_SEAMS, exists: () => false })).toEqual({
      pinned: false,
      reason: 'no-system-config',
    })
    expect(env).toEqual({})
  })

  // A crvy-rprtr run mode already exported our own generated config; pinning again
  // would write a second config and log a skip reason inside docker mode.
  test('skips when a crvy-rprtr run mode already pinned this environment', () => {
    const env: Record<string, string | undefined> = { FONTCONFIG_FILE: rootFontconfigPath() }
    expect(applyGrayscaleFontRendering(env, LINUX_SEAMS)).toEqual({ pinned: false, reason: 'already-pinned' })
    expect(env.FONTCONFIG_FILE).toBe(rootFontconfigPath())
  })

  test('pins over a foreign FONTCONFIG_FILE, which the generated config includes', () => {
    const env: Record<string, string | undefined> = { FONTCONFIG_FILE: '/etc/fonts/other.conf' }
    expect(applyGrayscaleFontRendering(env, LINUX_SEAMS)).toEqual({
      pinned: true,
      path: '/tmp/crvy-rprtr/fonts.conf',
    })
    expect(env.FONTCONFIG_FILE).toBe('/tmp/crvy-rprtr/fonts.conf')
  })
})
