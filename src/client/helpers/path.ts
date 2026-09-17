import {
  type CrvyRprtrSuite,
  type CrvyRprtrTest,
  type TestData,
  isTest,
  isDefined,
  getChildrenEntries,
} from '../../types'
import { isTestStatus, calcStatus } from './status'

/**
 * Fallback leaf key used when a test's `browser` field is empty. This only
 * happens for data produced by older reporters (before browser-label
 * resolution), where Playwright's implicit default project produced an empty
 * project name. Keeping `treeifyTests` and `syncTreeState`/`pathTokensFor`
 * aligned on this sentinel ensures live updates reach tests that would
 * otherwise be dropped by empty-browser guards.
 */
export const DEFAULT_BROWSER_KEY = 'default'

/**
 * Returns the leaf key for a test in the tree, substituting a sentinel for
 * empty browser strings (only possible for data from older reporters) so the
 * key is always non-empty and structural updates via `syncTreeState` can find
 * the same node.
 */
export function browserKeyFor(browser: string): string {
  return browser === '' ? DEFAULT_BROWSER_KEY : browser
}

export function getTestPath(test: Pick<TestData, 'browser' | 'title' | 'titlePath' | 'fileTokens'>): string[] {
  return [...(test.fileTokens ?? []), ...test.titlePath, test.title, test.browser].filter(isDefined)
}

export function getSuiteByPath(suite: CrvyRprtrSuite, path: string[]): CrvyRprtrSuite | CrvyRprtrTest | undefined {
  return path.reduce(
    (suiteOrTest: CrvyRprtrSuite | CrvyRprtrTest | undefined, pathToken: string) =>
      isTest(suiteOrTest) ? suiteOrTest : suiteOrTest?.children?.[pathToken],
    suite as CrvyRprtrSuite | CrvyRprtrTest | undefined,
  )
}

export function getTestByPath(suite: CrvyRprtrSuite, path: string[]): CrvyRprtrTest | null {
  const test = getSuiteByPath(suite, path) ?? suite
  return isTest(test) ? test : null
}

export function setSearchParams(testPath: string[]): void {
  const params = new URLSearchParams()
  testPath.forEach((p, i) => {
    params.set(`testPath[${i}]`, p)
  })
  window.history.pushState({ testPath }, '', `?${params.toString()}`)
}

export function getTestPathFromSearch(): string[] {
  const params = new URLSearchParams(window.location.search)
  const path: string[] = []
  let i = 0
  while (params.has(`testPath[${i}]`)) {
    path.push(params.get(`testPath[${i}]`)!)
    i++
  }
  return path
}

export function parseFilterString(value: string): {
  status: import('../../types').TestStatus | null
  subStrings: string[]
} {
  let status: import('../../types').TestStatus | null = null
  const subStrings: string[] = []
  value
    .split(' ')
    .filter((s) => s !== '')
    .map((word) => word.toLowerCase())
    .forEach((word) => {
      const match = /^status:(failed|success|pending|approved)$/i.exec(word)
      if (match !== null) {
        const matchedStatus = match[1]
        if (matchedStatus !== undefined && isTestStatus(matchedStatus)) {
          status = matchedStatus satisfies import('../../types').TestStatus
          return
        }
      }
      subStrings.push(word)
    })
  return { status, subStrings }
}

function appendTestToTree(rootSuite: CrvyRprtrSuite, test: TestData): void {
  const titlePath = test.titlePath ?? []
  const fileTokens = test.fileTokens ?? []
  const browser = browserKeyFor(test.browser ?? '')
  const title = test.title

  const pathParts: string[] = [...fileTokens, ...titlePath, title, browser].filter(
    (p): p is string => p !== undefined && p !== '',
  )
  const [browserName, ...testPathParts] = pathParts.reverse()
  if (browserName === undefined) return

  const lastSuite = testPathParts.reverse().reduce((suite, token) => {
    suite.children = suite.children ?? {}
    suite.children[token] ??= {
      path: [...suite.path, token],
      skip: false,
      opened: false,
      checked: true,
      indeterminate: false,
      children: {},
    }
    const subSuite = suite.children[token]
    if (subSuite === undefined || isTest(subSuite)) return suite
    subSuite.status = calcStatus(subSuite.status, test.status)
    suite.status = calcStatus(suite.status, subSuite.status)
    if (test.skip === false) subSuite.skip = false
    return subSuite
  }, rootSuite)

  lastSuite.children = lastSuite.children ?? {}
  lastSuite.children[browserName] = {
    ...test,
    checked: true,
  } as CrvyRprtrTest
}

export function treeifyTests(testsById: Record<string, TestData>): CrvyRprtrSuite {
  const rootSuite: CrvyRprtrSuite = {
    path: [],
    skip: false,
    opened: true,
    checked: true,
    indeterminate: false,
    children: {},
  }

  Object.values(testsById).forEach((test) => {
    if (test === undefined) return
    appendTestToTree(rootSuite, test)
  })

  return rootSuite
}

export function mergeTreeState(target: CrvyRprtrSuite, source: CrvyRprtrSuite): void {
  target.opened = source.opened
  target.checked = source.checked
  target.indeterminate = source.indeterminate
  for (const [key, targetChild] of getChildrenEntries(target.children)) {
    const sourceChild = source.children?.[key]
    if (targetChild === undefined || sourceChild === undefined) continue
    if (!isTest(targetChild) && !isTest(sourceChild)) {
      mergeTreeState(targetChild, sourceChild)
    } else if (isTest(targetChild) && isTest(sourceChild)) {
      targetChild.checked = sourceChild.checked
    }
  }
}
