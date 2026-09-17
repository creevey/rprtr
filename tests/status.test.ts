import { describe, expect, test } from 'bun:test'

import { countTestsStatus, describeResultDisplay, hasScreenshots, isNonVisual } from '../src/client/helpers'
import type { CrvyRprtrSuite, CrvyRprtrTest, TestResult } from '../src/types'

function testWith(overrides: Partial<CrvyRprtrTest>): CrvyRprtrTest {
  return {
    id: 'test-1',
    title: 'visual test',
    titlePath: [],
    browser: 'chromium',
    checked: false,
    ...overrides,
  }
}

function suiteWith(children: Record<string, CrvyRprtrTest | CrvyRprtrSuite>): CrvyRprtrSuite {
  return { path: [], skip: false, opened: true, checked: true, indeterminate: false, children }
}

function result(overrides: Partial<TestResult>): TestResult {
  return { status: 'success', retries: 0, ...overrides }
}

describe('status helpers', () => {
  test('treats declared-only visual entries as screenshots', () => {
    const testData = testWith({
      status: 'success',
      results: [
        {
          status: 'success',
          retries: 0,
          images: {
            header: { source: 'declared-only' },
          },
        },
      ],
    })

    expect(hasScreenshots(testData)).toBe(true)
  })

  test('a finished test without screenshot artifacts is non-visual', () => {
    const passedWithoutImages = testWith({
      status: 'success',
      results: [result({})],
    })
    expect(isNonVisual(passedWithoutImages)).toBe(true)
  })

  test('a test with screenshot artifacts is not non-visual', () => {
    const visual = testWith({
      status: 'success',
      results: [result({ images: { header: { source: 'baseline-only' } } })],
    })
    expect(isNonVisual(visual)).toBe(false)
  })

  test('a never-run test is not marked non-visual', () => {
    const discovered = testWith({ status: 'pending' })
    expect(discovered.results).toBeUndefined()
    expect(isNonVisual(discovered)).toBe(false)
  })

  test('a failed test without artifacts is non-visual', () => {
    const failedPlain = testWith({
      status: 'failed',
      results: [result({ status: 'failed', error: 'expect(received).toBe(42)' })],
    })
    expect(isNonVisual(failedPlain)).toBe(true)
  })

  test('a suite wrapping only non-visual tests is non-visual', () => {
    const suite = suiteWith({
      chromium: testWith({ status: 'success', results: [result({})] }),
    })
    expect(isNonVisual(suite)).toBe(true)
  })

  test('a suite mixing visual and non-visual tests is not marked non-visual', () => {
    const suite = suiteWith({
      chromium: testWith({ id: 'plain', status: 'success', results: [result({})] }),
      firefox: testWith({ id: 'visual', status: 'success', results: [result({ images: { header: {} } })] }),
    })
    expect(isNonVisual(suite)).toBe(false)
  })

  test('an empty suite is not non-visual', () => {
    expect(isNonVisual(suiteWith({}))).toBe(false)
  })

  test('countTestsStatus counts finished non-visual tests too', () => {
    const suite = suiteWith({
      'a.test.ts': suiteWith({
        chromium: testWith({ id: 'plain', status: 'success', results: [result({})] }),
        firefox: testWith({ id: 'visual', status: 'success', results: [result({ images: { header: {} } })] }),
      }),
    })
    expect(countTestsStatus(suite)).toEqual({
      approvedCount: 0,
      successCount: 2,
      failedCount: 0,
      pendingCount: 0,
    })
  })

  test('countTestsStatus counts never-run pending tests', () => {
    const suite = suiteWith({
      chromium: testWith({ id: 'd1', status: 'pending' }),
    })
    expect(countTestsStatus(suite)).toEqual({
      approvedCount: 0,
      successCount: 0,
      failedCount: 0,
      pendingCount: 1,
    })
  })
})

describe('describeResultDisplay', () => {
  test('a result with images renders the image', () => {
    expect(describeResultDisplay(result({ images: { header: {} } }))).toBe('image')
  })

  test('a failed result with an error and no images renders the error', () => {
    expect(describeResultDisplay(result({ status: 'failed', error: 'boom' }))).toBe('error')
  })

  test('a passed result without images renders the no-visual explanation', () => {
    expect(describeResultDisplay(result({}))).toBe('passed-no-visual')
  })

  test('a non-success result without images or error has no dedicated display', () => {
    expect(describeResultDisplay(result({ status: 'pending' }))).toBe('empty')
    expect(describeResultDisplay(undefined)).toBe('empty')
  })

  test('a failed result with images still renders the image (diff views tell the story)', () => {
    expect(describeResultDisplay(result({ status: 'failed', images: { header: { diff: '/d.png' } } }))).toBe('image')
  })
})
