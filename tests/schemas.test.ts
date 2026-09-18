import { describe, expect, test } from 'bun:test'

import { parseFontRendering } from '../src/schemas'

describe('parseFontRendering', () => {
  test('defaults to grayscale, matching both run modes', () => {
    expect(parseFontRendering({})).toBe('grayscale')
    expect(parseFontRendering({ fontRendering: undefined })).toBe('grayscale')
  })

  test('accepts both supported values', () => {
    expect(parseFontRendering({ fontRendering: 'grayscale' })).toBe('grayscale')
    expect(parseFontRendering({ fontRendering: 'inherit' })).toBe('inherit')
  })

  // A typo has to fail at reporter init rather than silently inheriting the
  // environment's antialiasing, which is the failure this change removes.
  test('rejects any other value, naming the option', () => {
    expect(() => parseFontRendering({ fontRendering: 'greyscale' })).toThrow(/fontRendering/)
    expect(() => parseFontRendering({ fontRendering: true })).toThrow(/fontRendering/)
  })
})
