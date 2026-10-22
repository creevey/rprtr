import { describe, expect, test } from 'bun:test'

import { getTestPath } from '../src/client/helpers'
import { testTreePath } from '../src/report-tree'
import type { TestData } from '../src/types'

function makeTest(overrides: Partial<TestData> = {}): TestData {
  return {
    id: 'test-1',
    titlePath: [],
    title: 'Test',
    browser: 'chromium',
    location: { file: 'tests/example.spec.ts', line: 1 },
    status: 'pending',
    results: [],
    ...overrides,
  }
}

describe('testTreePath', () => {
  test('renders a Storybook kind and story title without file tokens', () => {
    const testData = makeTest({
      titlePath: ['Components/Button'],
      title: 'Primary',
      fileTokens: ['tests', 'components', 'button.spec.ts'],
      browser: 'chromium',
    })

    expect(testTreePath(testData)).toEqual(['Components', 'Button', 'Primary', 'chromium'])
  })

  test('keeps nested describe levels in authored order', () => {
    const testData = makeTest({
      titlePath: ['Components', 'Button/Primary', 'States'],
      title: 'Hover',
      fileTokens: ['tests', 'button.spec.ts'],
      browser: 'firefox',
    })

    expect(testTreePath(testData)).toEqual(['Components', 'Button', 'Primary', 'States', 'Hover', 'firefox'])
  })

  test('splits a flat title that carries the Storybook separator', () => {
    const testData = makeTest({
      titlePath: [],
      title: 'Button/Primary',
      fileTokens: ['tests', 'button.spec.ts'],
      browser: 'webkit',
    })

    expect(testTreePath(testData)).toEqual(['Button', 'Primary', 'webkit'])
  })

  test('places the project leaf directly beneath the authored path', () => {
    const testData = makeTest({
      titlePath: ['Components/Button'],
      title: 'Primary',
      fileTokens: ['tests', 'button.spec.ts'],
      browser: 'dark',
    })

    expect(testTreePath(testData).at(-1)).toBe('dark')
    expect(testTreePath(testData)).toEqual(['Components', 'Button', 'Primary', 'dark'])
  })

  test('getTestPath returns the same tokens as the shared builder', () => {
    const testData = makeTest({
      titlePath: ['Components/Button'],
      title: 'Primary',
      fileTokens: ['tests', 'button.spec.ts'],
      browser: 'chromium',
    })

    expect(getTestPath(testData)).toEqual(testTreePath(testData))
  })
})

describe('authored path and file fallback', () => {
  test('a test without an authored path keeps its file tokens', () => {
    const testData = makeTest({
      titlePath: [],
      title: 'plain test',
      fileTokens: ['tests', 'plain.spec.ts'],
      browser: 'chromium',
    })

    expect(testTreePath(testData)).toEqual(['tests', 'plain.spec.ts', 'plain test', 'chromium'])
  })

  test('an authored test ignores its file tokens', () => {
    const testData = makeTest({
      titlePath: ['Components/Button'],
      title: 'Primary',
      fileTokens: ['tests', 'button.spec.ts'],
      browser: 'chromium',
    })

    expect(testTreePath(testData)).toEqual(['Components', 'Button', 'Primary', 'chromium'])
  })

  test('same-title plain tests from different files stay distinct', () => {
    const first = makeTest({
      id: 'first',
      titlePath: [],
      title: 'plain test',
      fileTokens: ['tests', 'first.spec.ts'],
      browser: 'chromium',
    })
    const second = makeTest({
      id: 'second',
      titlePath: [],
      title: 'plain test',
      fileTokens: ['tests', 'second.spec.ts'],
      browser: 'chromium',
    })

    expect(testTreePath(first)).not.toEqual(testTreePath(second))
  })
})
