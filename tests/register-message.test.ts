import { describe, expect, test } from 'bun:test'

import { RegisterDataSchema, safeParse } from '../src/schemas'

describe('RegisterDataSchema', () => {
  test('parses a payload that includes configFile and cwd', () => {
    const payload = {
      playwrightSnapshotDir: '/proj/tests/__screenshots__',
      playwrightTestDir: '/proj/tests',
      configFile: '/proj/playwright.config.ts',
      cwd: '/proj',
    }
    expect(safeParse(RegisterDataSchema, payload)).toEqual(payload)
  })

  test('parses an old payload that omits configFile and cwd (backward compat)', () => {
    const payload = {
      playwrightSnapshotDir: '/proj/tests/__screenshots__',
      playwrightTestDir: '/proj/tests',
    }
    expect(safeParse(RegisterDataSchema, payload)).toEqual(payload)
  })

  test('parses an empty payload', () => {
    expect(safeParse(RegisterDataSchema, {})).toEqual({})
  })
})
