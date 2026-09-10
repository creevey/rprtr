import { describe, expect, test } from 'bun:test'

import {
  GRAYSCALE_FONTCONFIG_XML,
  grayscaleFontconfigEnv,
  grayscaleRootFontconfigXml,
  resolveSystemFontconfig,
  rootFontconfigPath,
} from '../src/fontconfig'

const NOTHING_EXISTS = (): boolean => false
const EVERYTHING_EXISTS = (): boolean => true

describe('grayscaleRootFontconfigXml', () => {
  test('includes the system config it replaces and assigns rgba at font level', () => {
    const xml = grayscaleRootFontconfigXml('/etc/fonts/fonts.conf')
    expect(xml).toContain('<include ignore_missing="no">/etc/fonts/fonts.conf</include>')
    expect(xml).toContain('<match target="font">')
    expect(xml).toContain('<edit name="rgba" mode="assign"><const>none</const></edit>')
  })

  test('escapes XML metacharacters in the path', () => {
    expect(grayscaleRootFontconfigXml('/tmp/a&b/fonts.conf')).toContain('/tmp/a&amp;b/fonts.conf')
  })

  test('the drop-in form carries the rule without an include', () => {
    expect(GRAYSCALE_FONTCONFIG_XML).toContain('<match target="font">')
    expect(GRAYSCALE_FONTCONFIG_XML).not.toContain('<include')
  })
})

describe('resolveSystemFontconfig', () => {
  test("prefers the caller's own FONTCONFIG_FILE", () => {
    const env = { FONTCONFIG_FILE: '/opt/fonts.conf', FONTCONFIG_PATH: '/opt/fc' }
    expect(resolveSystemFontconfig(env, EVERYTHING_EXISTS)).toBe('/opt/fonts.conf')
  })

  test('falls back to FONTCONFIG_PATH, then to the distro default', () => {
    expect(resolveSystemFontconfig({ FONTCONFIG_PATH: '/opt/fc' }, EVERYTHING_EXISTS)).toBe('/opt/fc/fonts.conf')
    expect(resolveSystemFontconfig({}, EVERYTHING_EXISTS)).toBe('/etc/fonts/fonts.conf')
  })

  test('skips a missing candidate', () => {
    const exists = (path: string): boolean => path === '/usr/local/etc/fonts/fonts.conf'
    expect(resolveSystemFontconfig({ FONTCONFIG_FILE: '/gone.conf' }, exists)).toBe('/usr/local/etc/fonts/fonts.conf')
  })

  test('never resolves to our own generated config, which would self-include', () => {
    const env = { FONTCONFIG_FILE: rootFontconfigPath() }
    expect(resolveSystemFontconfig(env, EVERYTHING_EXISTS)).toBe('/etc/fonts/fonts.conf')
  })

  test('returns null when no config exists to include', () => {
    expect(resolveSystemFontconfig({}, NOTHING_EXISTS)).toBeNull()
  })
})

describe('grayscaleFontconfigEnv', () => {
  const writeConfig = (systemConfigPath: string): string => `/tmp/generated-for${systemConfigPath}`

  test('points FONTCONFIG_FILE at the generated config on linux', () => {
    const env = grayscaleFontconfigEnv({}, { platform: 'linux', exists: EVERYTHING_EXISTS, writeConfig })
    expect(env).toEqual({ FONTCONFIG_FILE: '/tmp/generated-for/etc/fonts/fonts.conf' })
  })

  test('does nothing outside linux, where fontconfig does not drive text AA', () => {
    for (const platform of ['darwin', 'win32'] as const) {
      expect(grayscaleFontconfigEnv({}, { platform, exists: EVERYTHING_EXISTS, writeConfig })).toBeNull()
    }
  })

  test('does nothing when no system config exists: replacing the root config would leave no fonts', () => {
    expect(grayscaleFontconfigEnv({}, { platform: 'linux', exists: NOTHING_EXISTS, writeConfig })).toBeNull()
  })
})
