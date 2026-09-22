import { describe, expect, test } from 'bun:test'

import { parseFontRendering, safeParse, WebSocketMessageSchema } from '../src/schemas'

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

describe('run-status schema', () => {
  test('accepts optional divergence notices', () => {
    const parsed = safeParse(WebSocketMessageSchema, {
      type: 'run-status',
      data: { running: true, mode: 'docker', notices: ['notice one', 'notice two'] },
    })

    expect(parsed).toEqual({
      type: 'run-status',
      data: { running: true, mode: 'docker', notices: ['notice one', 'notice two'] },
    })
  })

  test('still accepts payloads without notices', () => {
    expect(safeParse(WebSocketMessageSchema, { type: 'run-status', data: { running: false } })).toEqual({
      type: 'run-status',
      data: { running: false },
    })
    expect(safeParse(WebSocketMessageSchema, { type: 'run-status', data: { running: true, mode: 'local' } })).toEqual({
      type: 'run-status',
      data: { running: true, mode: 'local' },
    })
  })

  test('rejects malformed notices', () => {
    expect(safeParse(WebSocketMessageSchema, { type: 'run-status', data: { running: true, notices: [1] } })).toBeNull()
    expect(
      safeParse(WebSocketMessageSchema, { type: 'run-status', data: { running: true, notices: 'nope' } }),
    ).toBeNull()
  })
})
