import { describe, expect, test } from 'bun:test'

import { captureTestStatuses, restoreTestStatuses } from '../src/client/helpers/run-snapshot'
import { recalcAllSuiteStatuses } from '../src/client/helpers/suite'
import type { CrvyRprtrSuite, CrvyRprtrTest, TestStatus } from '../src/types'

function makeTest(id: string, status: TestStatus | undefined): CrvyRprtrTest {
  return { id, titlePath: [], browser: 'chromium', title: id, status, checked: true }
}

function makeSuite(children: CrvyRprtrSuite['children']): CrvyRprtrSuite {
  return { path: [], skip: false, opened: false, checked: true, indeterminate: false, children }
}

describe('captureTestStatuses', () => {
  test('captures id -> status for every descendant test', () => {
    const tree = makeSuite({
      a: makeTest('a', 'failed'),
      group: makeSuite({
        b: makeTest('b', 'success'),
      }),
    })
    const snapshot = captureTestStatuses(tree)
    expect(snapshot.get('a')).toBe('failed')
    expect(snapshot.get('b')).toBe('success')
    expect(snapshot.size).toBe(2)
  })

  test('is scoped to the given subtree', () => {
    const target = makeSuite({ a: makeTest('a', 'failed') })
    const tree = makeSuite({ other: makeTest('other', 'success'), target })
    const snapshot = captureTestStatuses(target)
    expect(snapshot.has('a')).toBe(true)
    expect(snapshot.has('other')).toBe(false)
    // sanity: capturing the full tree would include the sibling
    expect(captureTestStatuses(tree).has('other')).toBe(true)
  })

  test('captures undefined status as undefined', () => {
    const tree = makeSuite({ a: makeTest('a', undefined) })
    const snapshot = captureTestStatuses(tree)
    expect(snapshot.has('a')).toBe(true)
    expect(snapshot.get('a')).toBeUndefined()
  })
})

describe('restoreTestStatuses', () => {
  test('restores only ids not in receivedIds and returns the count', () => {
    const testA = makeTest('a', 'pending')
    const testB = makeTest('b', 'pending')
    const tree = makeSuite({ a: testA, b: testB })
    const snapshot = new Map<string, TestStatus | undefined>([
      ['a', 'failed'],
      ['b', 'success'],
    ])
    const restored = restoreTestStatuses(tree, snapshot, new Set(['b']))
    expect(restored).toBe(1)
    expect(testA.status).toBe('failed')
    expect(testB.status).toBe('pending')
  })

  test('walks nested suites', () => {
    const inner = makeTest('inner', 'pending')
    const tree = makeSuite({ group: makeSuite({ inner }) })
    const snapshot = new Map<string, TestStatus | undefined>([['inner', 'approved']])
    expect(restoreTestStatuses(tree, snapshot, new Set())).toBe(1)
    expect(inner.status).toBe('approved')
  })

  test('restore then recalcAllSuiteStatuses yields the correct parent rollup', () => {
    const testA = makeTest('a', 'pending')
    const testB = makeTest('b', 'success')
    const group = makeSuite({ a: testA, b: testB })
    const tree = makeSuite({ group })
    const snapshot = new Map<string, TestStatus | undefined>([['a', 'failed']])
    restoreTestStatuses(tree, snapshot, new Set(['b']))
    recalcAllSuiteStatuses(tree)
    // 'a' reverted to failed, 'b' untouched (success); suite rolls up to failed
    expect(group.status).toBe('failed')
  })

  test('restores undefined status when snapshot maps id -> undefined', () => {
    const t = makeTest('a', 'failed')
    const tree = makeSuite({ a: t })
    restoreTestStatuses(tree, new Map([['a', undefined]]), new Set())
    expect(t.status).toBeUndefined()
  })
})

describe('empty / single-test roots', () => {
  test('captureTestStatuses on an empty suite returns an empty map', () => {
    expect(captureTestStatuses(makeSuite({})).size).toBe(0)
  })

  test('restoreTestStatuses on an empty suite restores nothing', () => {
    expect(restoreTestStatuses(makeSuite({}), new Map([['x', 'failed']]), new Set())).toBe(0)
  })

  test('captureTestStatuses accepts a bare test as the root', () => {
    const snapshot = captureTestStatuses(makeTest('solo', 'success'))
    expect(snapshot.get('solo')).toBe('success')
    expect(snapshot.size).toBe(1)
  })
})
