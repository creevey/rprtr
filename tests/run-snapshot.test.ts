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
    const target = makeSuite({
      group: makeSuite({ a: makeTest('a', 'failed') }),
    })
    const _tree = makeSuite({ other: makeTest('other', 'success'), target })
    const snapshot = captureTestStatuses(target)
    expect(snapshot.has('a')).toBe(true)
    expect(snapshot.has('other')).toBe(false)
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
})
