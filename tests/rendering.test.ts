import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { rootFontconfigPath } from '../src/fontconfig'
import {
  DETERMINISTIC_CHROMIUM_ARGS,
  applyGrayscaleFontRendering,
  deterministicChromiumLaunchOptions,
  deterministicLaunchOptions,
} from '../src/rendering'

// These functions read the real process.env, and the reporter pins FONTCONFIG_FILE
// on it in its constructor — so on Linux the result depended on whether some
// earlier test file happened to construct a reporter. Each block states the
// ambient pin state it needs instead of inheriting one.
const originalFontconfigFile = process.env.FONTCONFIG_FILE

function restoreFontconfigFile(): void {
  if (originalFontconfigFile === undefined) delete process.env.FONTCONFIG_FILE
  else process.env.FONTCONFIG_FILE = originalFontconfigFile
}

beforeEach(() => {
  delete process.env.FONTCONFIG_FILE
})

afterEach(restoreFontconfigFile)

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

// The reporter pins the real process.env in its constructor, so on Linux any
// test file that constructed one leaves FONTCONFIG_FILE set for every later
// test in the same bun process. deterministicLaunchOptions reads process.env,
// so it must behave the same either way.
describe('deterministicLaunchOptions in an already-pinned process', () => {
  beforeEach(() => {
    process.env.FONTCONFIG_FILE = rootFontconfigPath()
  })

  test('is still a no-op where fontconfig does not apply', () => {
    const base = {}
    expect(deterministicLaunchOptions(base, { ...LINUX_SEAMS, platform: 'darwin' })).toBe(base)
    expect(deterministicLaunchOptions(base, { ...LINUX_SEAMS, exists: () => false })).toBe(base)
  })

  test('leaves options alone when the browser would inherit the pin anyway', () => {
    const base = { args: ['--no-sandbox'] }
    expect(deterministicLaunchOptions(base, LINUX_SEAMS)).toBe(base)
  })

  // base.env REPLACES the browser environment, so the inherited pin is lost
  // unless it is written back in.
  test('still materializes the pin when the caller replaces the environment', () => {
    const options = deterministicLaunchOptions({ env: { MY_VAR: 'mine' } }, LINUX_SEAMS)
    expect(options.env?.FONTCONFIG_FILE).toBe(rootFontconfigPath())
    expect(options.env?.MY_VAR).toBe('mine')
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
