import { describe, expect, test } from 'bun:test'

import {
  DETERMINISTIC_CHROMIUM_ARGS,
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
