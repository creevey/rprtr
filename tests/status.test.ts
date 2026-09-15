import { describe, expect, test } from 'bun:test'

import { countTestsStatus, hasScreenshots, isTreeVisible } from '../src/client/helpers'
import type { CrvyRprtrSuite, CrvyRprtrTest } from '../src/types'

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

describe('status helpers', () => {
  test('treats declared-only visual entries as visible screenshots', () => {
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

  test('a never-run test without results is tree-visible', () => {
    const discovered = testWith({ status: 'pending' })
    expect(discovered.results).toBeUndefined()
    expect(isTreeVisible(discovered)).toBe(true)
  })

  test('a finished test without screenshot artifacts stays hidden', () => {
    const passedWithoutImages = testWith({
      status: 'success',
      results: [{ status: 'success', retries: 0 }],
    })
    expect(isTreeVisible(passedWithoutImages)).toBe(false)
  })

  test('a suite is tree-visible when any descendant is', () => {
    const suite = suiteWith({
      'a.test.ts': suiteWith({
        chromium: testWith({ status: 'pending' }),
      }),
    })
    expect(isTreeVisible(suite)).toBe(true)
  })

  test('an empty suite is not tree-visible', () => {
    expect(isTreeVisible(suiteWith({}))).toBe(false)
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
