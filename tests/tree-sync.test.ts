import { describe, expect, test } from 'bun:test'

import { collectTestsById, syncTreeState, treeifyTests } from '../src/client/helpers'
import type { CrvyRprtrSuite, TestData } from '../src/types'

function makeTest(overrides: Partial<TestData> = {}): TestData {
  return {
    id: 'test-1',
    titlePath: ['Suite'],
    title: 'Test',
    browser: 'chromium',
    location: { file: 'tests/example.spec.ts', line: 1 },
    status: 'pending',
    results: [],
    ...overrides,
  }
}

function findTest(
  suite: CrvyRprtrSuite,
  id: string,
): { test: import('../src/types').CrvyRprtrTest; browserKey: string } | null {
  for (const [key, child] of Object.entries(suite.children ?? {})) {
    if (child === undefined || child === null) continue
    if ('id' in child && child.id === id) {
      return { test: child, browserKey: key }
    }
    if (!('id' in child)) {
      const nested = findTest(child, id)
      if (nested !== null) return nested
    }
  }
  return null
}

describe('syncTreeState', () => {
  test('preserves the same test object reference when data is unchanged', () => {
    const initial: Record<string, TestData> = {
      'test-1': makeTest({ id: 'test-1', status: 'failed' }),
    }
    const tree = treeifyTests(initial)
    const originalTestRef = findTest(tree, 'test-1')?.test
    expect(originalTestRef).toBeDefined()

    const sameData: Record<string, TestData> = {
      'test-1': makeTest({ id: 'test-1', status: 'failed' }),
    }
    const changed = syncTreeState(tree, sameData)

    expect(changed).toBe(false)
    const afterRef = findTest(tree, 'test-1')?.test
    expect(afterRef).toBe(originalTestRef)
  })

  test('mutates the test in place when status changes and keeps the same reference', () => {
    const initial: Record<string, TestData> = {
      'test-1': makeTest({ id: 'test-1', status: 'failed' }),
    }
    const tree = treeifyTests(initial)
    const originalTestRef = findTest(tree, 'test-1')?.test
    expect(originalTestRef).toBeDefined()
    expect(originalTestRef?.status).toBe('failed')

    const updated: Record<string, TestData> = {
      'test-1': makeTest({ id: 'test-1', status: 'success' }),
    }
    const changed = syncTreeState(tree, updated)

    expect(changed).toBe(true)
    const afterRef = findTest(tree, 'test-1')?.test
    expect(afterRef).toBe(originalTestRef)
    expect(afterRef?.status).toBe('success')
  })

  test('removes tests that no longer exist in the new data', () => {
    const initial: Record<string, TestData> = {
      'test-1': makeTest({ id: 'test-1' }),
      'test-2': makeTest({ id: 'test-2', title: 'Other' }),
    }
    const tree = treeifyTests(initial)
    expect(findTest(tree, 'test-1')).not.toBeNull()
    expect(findTest(tree, 'test-2')).not.toBeNull()

    const updated: Record<string, TestData> = {
      'test-1': makeTest({ id: 'test-1' }),
    }
    const changed = syncTreeState(tree, updated)

    expect(changed).toBe(true)
    expect(findTest(tree, 'test-1')).not.toBeNull()
    expect(findTest(tree, 'test-2')).toBeNull()
  })

  test('adds new tests and creates intermediate suites as needed', () => {
    const tree = treeifyTests({})
    const updated: Record<string, TestData> = {
      'test-new': makeTest({
        id: 'test-new',
        titlePath: ['New Suite', 'Sub Suite'],
        title: 'New Test',
        browser: 'firefox',
      }),
    }
    const changed = syncTreeState(tree, updated)

    expect(changed).toBe(true)
    const added = findTest(tree, 'test-new')
    expect(added).not.toBeNull()
    expect(added?.browserKey).toBe('firefox')
  })

  test('recalculates ancestor suite statuses when a test status changes', () => {
    const tree = treeifyTests({
      'test-1': makeTest({ id: 'test-1', title: 'Test One', status: 'failed' }),
      'test-2': makeTest({ id: 'test-2', title: 'Test Two', status: 'success' }),
    })

    const suiteAfterInitial = tree.children?.['Suite']
    expect(suiteAfterInitial?.status).toBe('failed')

    const updated: Record<string, TestData> = {
      'test-1': makeTest({ id: 'test-1', title: 'Test One', status: 'success' }),
      'test-2': makeTest({ id: 'test-2', title: 'Test Two', status: 'success' }),
    }
    syncTreeState(tree, updated)

    const suiteAfterSync = tree.children?.['Suite']
    expect(suiteAfterSync?.status).toBe('success')
  })

  test('recalculates ancestor suite statuses when a test is removed', () => {
    const tree = treeifyTests({
      'test-1': makeTest({ id: 'test-1', title: 'Test One', status: 'failed' }),
      'test-2': makeTest({ id: 'test-2', title: 'Test Two', status: 'success' }),
    })

    expect(tree.children?.['Suite']?.status).toBe('failed')

    const updated: Record<string, TestData> = {
      'test-2': makeTest({ id: 'test-2', title: 'Test Two', status: 'success' }),
    }
    syncTreeState(tree, updated)

    expect(findTest(tree, 'test-1')).toBeNull()
    expect(tree.children?.['Suite']?.status).toBe('success')
  })

  test('syncTreeState removes tests not in the update set (by design)', () => {
    const tree = treeifyTests({
      'test-1': makeTest({ id: 'test-1', title: 'Test One', status: 'pending' }),
      'test-2': makeTest({ id: 'test-2', title: 'Test Two', status: 'pending' }),
    })

    // Syncing with only test-1 should remove test-2
    syncTreeState(tree, { 'test-1': makeTest({ id: 'test-1', title: 'Test One', status: 'success' }) })

    expect(findTest(tree, 'test-1')).not.toBeNull()
    expect(findTest(tree, 'test-1')?.test.status).toBe('success')
    expect(findTest(tree, 'test-2')).toBeNull()
  })

  test('preserves all tests when merged with existing data before sync', () => {
    const tree = treeifyTests({
      'test-1': makeTest({ id: 'test-1', title: 'Test One', status: 'pending' }),
      'test-2': makeTest({ id: 'test-2', title: 'Test Two', status: 'pending' }),
      'test-3': makeTest({ id: 'test-3', title: 'Test Three', browser: 'firefox', status: 'pending' }),
    })

    // Merge incoming update with existing tests (what the WebSocket handler should do)
    const existing = collectTestsById(tree)
    const update = makeTest({ id: 'test-1', title: 'Test One', status: 'success' })
    syncTreeState(tree, { ...existing, [update.id]: update })

    // All tests should still exist
    expect(findTest(tree, 'test-1')).not.toBeNull()
    expect(findTest(tree, 'test-1')?.test.status).toBe('success')
    expect(findTest(tree, 'test-2')).not.toBeNull()
    expect(findTest(tree, 'test-3')).not.toBeNull()
  })

  test('preserves user checked state when updating an existing test', () => {
    const initial: Record<string, TestData> = {
      'test-1': makeTest({ id: 'test-1' }),
    }
    const tree = treeifyTests(initial)
    const originalTest = findTest(tree, 'test-1')?.test
    expect(originalTest).toBeDefined()
    originalTest!.checked = false

    const updated: Record<string, TestData> = {
      'test-1': makeTest({ id: 'test-1', status: 'failed' }),
    }
    syncTreeState(tree, updated)

    expect(originalTest?.checked).toBe(false)
    expect(originalTest?.status).toBe('failed')
  })
})

describe('collectTestsById', () => {
  test('flattens a tree into an id-indexed map of TestData', () => {
    const tree = treeifyTests({
      'test-1': makeTest({ id: 'test-1', title: 'Test One' }),
      'test-2': makeTest({ id: 'test-2', title: 'Test Two', browser: 'firefox' }),
    })

    const collected = collectTestsById(tree)
    expect(Object.keys(collected).sort()).toEqual(['test-1', 'test-2'])
    expect(collected['test-1']?.title).toBe('Test One')
    expect(collected['test-2']?.browser).toBe('firefox')
  })

  test('returns an empty object for an empty tree', () => {
    expect(collectTestsById(treeifyTests({}))).toEqual({})
  })

  test('reflects mutations to the tree', () => {
    const tree = treeifyTests({ 'test-1': makeTest({ id: 'test-1' }) })
    expect(collectTestsById(tree)['test-1']?.status).toBe('pending')

    syncTreeState(tree, { 'test-1': makeTest({ id: 'test-1', status: 'failed' }) })
    expect(collectTestsById(tree)['test-1']?.status).toBe('failed')
  })
})
