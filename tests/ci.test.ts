import { expect, test } from 'bun:test'

import { isCI } from '../src/ci'

test('isCI is false when CI is unset', () => {
  expect(isCI({})).toBe(false)
})

test('isCI is false for falsy CI values', () => {
  expect(isCI({ CI: '' })).toBe(false)
  expect(isCI({ CI: 'false' })).toBe(false)
  expect(isCI({ CI: '0' })).toBe(false)
})

test('isCI is true for truthy CI values', () => {
  expect(isCI({ CI: 'true' })).toBe(true)
  expect(isCI({ CI: '1' })).toBe(true)
})
