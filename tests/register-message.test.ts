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

  test('parses a Vitest register carrying runner, configFile, and cwd', () => {
    const payload = {
      vitestAttachmentsDir: '/proj/.vitest-attachments',
      vitestReferenceDir: '/proj',
      configFile: '/proj/vitest.config.ts',
      cwd: '/proj',
      runner: 'vitest' as const,
    }
    expect(safeParse(RegisterDataSchema, payload)).toEqual(payload)
  })

  test('rejects unknown runner values', () => {
    expect(safeParse(RegisterDataSchema, { runner: 'jest' })).toBeNull()
    expect(safeParse(RegisterDataSchema, { runner: 'playwright' })).toBeNull()
  })

  test('leaves runner undefined when absent (Playwright default)', () => {
    const parsed = safeParse(RegisterDataSchema, { configFile: '/proj/playwright.config.ts', cwd: '/proj' })
    expect(parsed).toEqual({ configFile: '/proj/playwright.config.ts', cwd: '/proj' })
    expect(parsed?.runner).toBeUndefined()
  })
})
