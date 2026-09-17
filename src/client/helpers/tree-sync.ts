import {
  type CrvyRprtrSuite,
  type CrvyRprtrTest,
  type TestData,
  isTest,
  getChildrenEntries,
  getChildrenArray,
  getChildrenKeys,
} from '../../types'
import { browserKeyFor, getSuiteByPath } from './path'
import { calcStatus } from './status'
import { isTestDataEqual, copyMutableFields } from './test-equality'

type OldTestEntry = {
  test: CrvyRprtrTest
  parent: CrvyRprtrSuite
  parentPath: string[]
  browserKey: string
}

function collectOldTests(suite: CrvyRprtrSuite, parentPath: string[], out: Map<string, OldTestEntry>): void {
  for (const [key, child] of getChildrenEntries(suite.children)) {
    if (child === undefined) continue
    if (isTest(child)) {
      out.set(child.id, { test: child, parent: suite, parentPath, browserKey: key })
    } else {
      collectOldTests(child, [...parentPath, key], out)
    }
  }
}

export function collectTestsById(suite: CrvyRprtrSuite): Record<string, TestData> {
  const out: Record<string, TestData> = {}
  function walk(node: CrvyRprtrSuite): void {
    for (const child of getChildrenArray(node.children)) {
      if (child === undefined) continue
      if (isTest(child)) {
        out[child.id] = child
      } else {
        walk(child)
      }
    }
  }
  walk(suite)
  return out
}

function pathTokensFor(test: TestData): { suitePath: string[]; browserKey: string } | null {
  const titlePath = test.titlePath ?? []
  const fileTokens = test.fileTokens ?? []
  const title = test.title
  if (title === undefined || title === '') return null
  const browser = browserKeyFor(test.browser ?? '')
  const pathParts: string[] = [...fileTokens, ...titlePath, title, browser].filter(
    (p): p is string => p !== undefined && p !== '',
  )
  const reversed = pathParts.reverse()
  const browserKey = reversed[0]
  if (browserKey === undefined) return null
  return { suitePath: reversed.slice(1).reverse(), browserKey }
}

function ensureSuitePath(root: CrvyRprtrSuite, path: string[]): CrvyRprtrSuite {
  let suite: CrvyRprtrSuite = root
  for (const token of path) {
    suite.children = suite.children ?? {}
    const existing = suite.children[token]
    if (existing !== undefined && !isTest(existing)) {
      suite = existing
      continue
    }
    const nextSuite: CrvyRprtrSuite = {
      path: [...suite.path, token],
      skip: false,
      opened: false,
      checked: true,
      indeterminate: false,
      children: {},
    }
    suite.children[token] = nextSuite
    suite = nextSuite
  }
  return suite
}

function pruneEmptySuites(suite: CrvyRprtrSuite): void {
  if (suite.children === undefined) return
  for (const [key, child] of getChildrenEntries(suite.children)) {
    if (child === undefined || isTest(child)) continue
    pruneEmptySuites(child)
    if (getChildrenKeys(child.children).length === 0) {
      delete suite.children?.[key]
    }
  }
}

function updateTestInPlace(target: CrvyRprtrTest, source: TestData): void {
  copyMutableFields(target, source)
}

function recalcAncestorStatuses(root: CrvyRprtrSuite, parentSuitePath: string[]): void {
  for (let i = parentSuitePath.length; i > 0; i--) {
    const ancestorPath = parentSuitePath.slice(0, i)
    const ancestor = getSuiteByPath(root, ancestorPath)
    if (ancestor === undefined || isTest(ancestor)) continue
    const childStatuses = getChildrenArray(ancestor.children).map(({ status }) => status)
    ancestor.status = childStatuses.length === 0 ? undefined : childStatuses.reduce(calcStatus)
  }
  const rootChildStatuses = getChildrenArray(root.children).map(({ status }) => status)
  root.status = rootChildStatuses.length === 0 ? undefined : rootChildStatuses.reduce(calcStatus)
}

function pruneRemovedTests(
  oldTests: Map<string, OldTestEntry>,
  expectedIds: Set<string>,
  touchedSuitePaths: Set<string>,
): boolean {
  let changed = false
  for (const [id, oldEntry] of oldTests) {
    if (!expectedIds.has(id)) {
      // Only clear the slot when it still holds this exact test — a streamed
      // replacement may already occupy the same path + browser key, and that
      // node must survive its discovered predecessor's removal.
      const slot = oldEntry.parent.children?.[oldEntry.browserKey]
      if (slot !== undefined && isTest(slot) && slot.id === id) {
        delete oldEntry.parent.children?.[oldEntry.browserKey]
      }
      touchedSuitePaths.add(oldEntry.parentPath.join('\u0000'))
      changed = true
    }
  }
  return changed
}

function applyTestsToTree(
  target: CrvyRprtrSuite,
  testsById: Record<string, TestData>,
  oldTests: Map<string, OldTestEntry>,
  expectedIds: Set<string>,
  touchedSuitePaths: Set<string>,
): boolean {
  let changed = false
  for (const newTest of Object.values(testsById)) {
    if (newTest === undefined) continue
    const tokens = pathTokensFor(newTest)
    if (tokens === null) continue
    const oldEntry = oldTests.get(newTest.id)
    if (oldEntry !== undefined && oldEntry.browserKey === tokens.browserKey) {
      if (!isTestDataEqual(oldEntry.test, newTest)) {
        const statusChanged = oldEntry.test.status !== newTest.status
        updateTestInPlace(oldEntry.test, newTest)
        changed = true
        if (statusChanged) {
          touchedSuitePaths.add(tokens.suitePath.join('\u0000'))
        }
      }
    } else {
      if (oldEntry !== undefined) {
        delete oldEntry.parent.children?.[oldEntry.browserKey]
      }
      const parent = ensureSuitePath(target, tokens.suitePath)
      parent.children = parent.children ?? {}
      parent.children[tokens.browserKey] = {
        ...newTest,
        checked: oldEntry?.test.checked ?? true,
      } as CrvyRprtrTest
      changed = true
      touchedSuitePaths.add(tokens.suitePath.join('\u0000'))
    }
  }
  if (pruneRemovedTests(oldTests, expectedIds, touchedSuitePaths)) changed = true
  return changed
}

export function syncTreeState(target: CrvyRprtrSuite, testsById: Record<string, TestData>): boolean {
  const oldTests = new Map<string, OldTestEntry>()
  collectOldTests(target, [], oldTests)
  const expectedIds = new Set(Object.keys(testsById))
  const touchedSuitePaths = new Set<string>()
  const changed = applyTestsToTree(target, testsById, oldTests, expectedIds, touchedSuitePaths)
  for (const joinedPath of touchedSuitePaths) {
    recalcAncestorStatuses(target, joinedPath.split('\u0000'))
  }
  if (changed) {
    pruneEmptySuites(target)
  }
  return changed
}
