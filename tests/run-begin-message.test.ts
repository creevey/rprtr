import { describe, expect, test } from 'bun:test'

import { IncomingWebSocketMessageSchema, RunBeginDataSchema, safeParse } from '../src/schemas'

describe('RunBeginDataSchema', () => {
  test('parses a payload carrying the announced test ids', () => {
    const payload = { testIds: ['test-1', 'test-2'] }
    expect(safeParse(RunBeginDataSchema, payload)).toEqual(payload)
  })

  test('parses an empty announcement', () => {
    expect(safeParse(RunBeginDataSchema, { testIds: [] })).toEqual({ testIds: [] })
  })

  test('rejects a payload without testIds', () => {
    expect(safeParse(RunBeginDataSchema, {})).toBeNull()
  })

  test('rejects a non-array testIds value', () => {
    expect(safeParse(RunBeginDataSchema, { testIds: 'test-1' })).toBeNull()
  })

  test('rejects an array carrying non-string ids', () => {
    expect(safeParse(RunBeginDataSchema, { testIds: [1, 2] })).toBeNull()
  })
})

describe('incoming run-begin message', () => {
  test('accepts a run-begin message type', () => {
    const message = { type: 'run-begin' as const, data: { testIds: ['test-1'] } }
    expect(safeParse(IncomingWebSocketMessageSchema, message)).toEqual(message)
  })

  test('rejects unknown message types', () => {
    expect(safeParse(IncomingWebSocketMessageSchema, { type: 'run-start', data: {} })).toBeNull()
  })
})
