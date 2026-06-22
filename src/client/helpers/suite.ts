import {
  type CrvyRprtrSuite,
  type CrvyRprtrTest,
  type TestData,
  isTest,
  isDefined,
  getChildrenArray,
  getChildrenEntries,
  getChildrenKeys,
} from '../../types'
import { getSuiteByPath } from './path'
import { calcStatus } from './status'

export interface CrvyRprtrViewFilter {
  status: import('../../types').TestStatus | null
  subStrings: string[]
}

export interface CrvyRprtrTestsStatus {
  successCount: number
  failedCount: number
  pendingCount: number
  approvedCount: number
}

function makeEmptySuiteNode(path: string[] = []): CrvyRprtrSuite {
  return {
    path,
    skip: true,
    opened: false,
    checked: true,
    indeterminate: false,
    children: {},
  }
}

function checkTests(suiteOrTest: CrvyRprtrSuite | CrvyRprtrTest, checked: boolean): void {
  suiteOrTest.checked = checked
  if (!isTest(suiteOrTest)) {
    suiteOrTest.indeterminate = false
    getChildrenArray(suiteOrTest.children).forEach((child) => {
      checkTests(child, checked)
    })
  }
}

function updateChecked(suite: CrvyRprtrSuite): void {
  const children = getChildrenArray(suite.children).filter((child) => child.skip === false)
  const checkedEvery = children.every((test) => test.checked)
  const checkedSome = children.some((test) => test.checked)
  const indeterminate =
    children.some((test) => (isTest(test) ? false : test.indeterminate)) || (!checkedEvery && checkedSome)
  const checked = indeterminate || suite.checked === checkedEvery ? suite.checked : checkedEvery
  suite.checked = checked
  suite.indeterminate = indeterminate
}

export function checkSuite(suite: CrvyRprtrSuite, path: string[], checked: boolean): void {
  const subSuite = getSuiteByPath(suite, path)
  if (subSuite) checkTests(subSuite, checked)
  path
    .slice(0, -1)
    .map((_, index, tokens) => tokens.slice(0, tokens.length - index))
    .forEach((parentPath) => {
      const parentSuite = getSuiteByPath(suite, parentPath)
      if (isTest(parentSuite)) return
      if (parentSuite) updateChecked(parentSuite)
    })
  updateChecked(suite)
}

export function openSuite(suite: CrvyRprtrSuite, path: string[], opened: boolean): void {
  const subSuite = path.reduce(
    (suiteOrTest: CrvyRprtrSuite | CrvyRprtrTest | undefined, pathToken: string) => {
      if (suiteOrTest && !isTest(suiteOrTest)) {
        if (opened) suiteOrTest.opened = opened
        return suiteOrTest.children?.[pathToken]
      }
    },
    suite as CrvyRprtrSuite | CrvyRprtrTest | undefined,
  )
  if (subSuite && !isTest(subSuite)) subSuite.opened = opened
}

export function filterTests(suite: CrvyRprtrSuite, filter: CrvyRprtrViewFilter): CrvyRprtrSuite {
  const { status, subStrings } = filter
  if (!status && !subStrings.length) return suite
  const filteredSuite: CrvyRprtrSuite = { ...suite, children: {} }
  getChildrenEntries(suite.children).forEach(([title, suiteOrTest]) => {
    if (suiteOrTest.skip === true) return
    if (!status && subStrings.some((sub) => title.toLowerCase().includes(sub))) {
      filteredSuite.children = filteredSuite.children ?? {}
      filteredSuite.children[title] = suiteOrTest
    } else if (isTest(suiteOrTest)) {
      if (status && suiteOrTest.status && ['pending', 'running', status].includes(suiteOrTest.status)) {
        filteredSuite.children = filteredSuite.children ?? {}
        filteredSuite.children[title] = suiteOrTest
      }
    } else {
      const filteredSubSuite = filterTests(suiteOrTest, filter)
      if (getChildrenKeys(filteredSubSuite.children).length === 0) return
      filteredSuite.children = filteredSuite.children ?? {}
      filteredSuite.children[title] = filteredSubSuite
    }
  })
  return filteredSuite
}

export function flattenSuite(suite: CrvyRprtrSuite): { title: string; suite: CrvyRprtrSuite | CrvyRprtrTest }[] {
  if (!suite.opened) return []
  return getChildrenEntries(suite.children).flatMap(([title, subSuite]) => [
    { title, suite: subSuite },
    ...(isTest(subSuite) ? [] : flattenSuite(subSuite)),
  ])
}

export function updateTestStatus(suite: CrvyRprtrSuite, path: string[], update: Partial<TestData>): void {
  const title = path.shift()
  if (title === undefined) return
  suite.children = suite.children ?? {}
  const suiteOrTest =
    suite.children[title] ??
    (suite.children[title] =
      path.length === 0
        ? {
            ...update,
            checked: suite.checked,
            id: update.id ?? '',
            titlePath: update.titlePath ?? [],
            browser: update.browser ?? '',
            title: update.title ?? '',
          }
        : { ...makeEmptySuiteNode([...suite.path, title]), checked: suite.checked })
  if (isTest(suiteOrTest)) {
    const test = suiteOrTest
    const { skip, status, results, approved } = update
    if (isDefined(skip)) test.skip = skip
    if (isDefined(status)) test.status = status
    if (isDefined(results)) {
      if (test.results) test.results.push(...results)
      else test.results = results
    }
    if (approved === null) test.approved = null
    else if (approved !== undefined)
      Object.entries(approved).forEach(
        ([image, retry]) => retry !== undefined && ((test.approved = test.approved ?? {})[image] = retry),
      )
  } else {
    updateTestStatus(suiteOrTest, path, update)
  }
  suite.skip = getChildrenArray(suite.children)
    .map(({ skip }) => skip)
    .every(Boolean)
  suite.status = getChildrenArray(suite.children)
    .map(({ status }) => status)
    .reduce(calcStatus)
}

export function recalcSuiteStatuses(root: CrvyRprtrSuite, testPath: string[]): void {
  const ancestorPaths = testPath.slice(0, -1).map((_, index, tokens) => tokens.slice(0, tokens.length - index))
  for (const parentPath of ancestorPaths) {
    const parentSuite = getSuiteByPath(root, parentPath)
    if (parentSuite && !isTest(parentSuite)) {
      parentSuite.status = getChildrenArray(parentSuite.children)
        .map(({ status }) => status)
        .reduce(calcStatus)
    }
  }
  root.status = getChildrenArray(root.children)
    .map(({ status }) => status)
    .reduce(calcStatus)
}

export function recalcAllSuiteStatuses(suite: CrvyRprtrSuite): void {
  for (const child of getChildrenArray(suite.children)) {
    if (!isTest(child)) {
      recalcAllSuiteStatuses(child)
    }
  }
  suite.status = getChildrenArray(suite.children)
    .map(({ status }) => status)
    .reduce(calcStatus)
}

export function markTestsPending(node: CrvyRprtrSuite | CrvyRprtrTest): void {
  if (isTest(node)) {
    node.status = 'pending'
    return
  }
  getChildrenArray(node.children).forEach(markTestsPending)
}

export function removeTests(suite: CrvyRprtrSuite, path: string[]): void {
  const title = path.shift()
  if (title === undefined) return
  const suiteOrTest = suite.children?.[title]
  if (suiteOrTest && !isTest(suiteOrTest)) removeTests(suiteOrTest, path)
  if (isTest(suiteOrTest) || getChildrenKeys(suiteOrTest?.children).length === 0) {
    const { [title]: _, ...remaining } = suite.children ?? {}
    suite.children = remaining
  }
  if (getChildrenKeys(suite.children).length === 0) return
  updateChecked(suite)
  suite.skip = getChildrenArray(suite.children)
    .map(({ skip }) => skip)
    .every(Boolean)
  suite.status = getChildrenArray(suite.children)
    .map(({ status }) => status)
    .reduce(calcStatus)
}
