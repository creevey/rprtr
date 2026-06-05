import { type CrvyRprtrSuite, type CrvyRprtrTest, type TestStatus, isTest, getChildrenArray } from '../../types'

export const testStatuses: TestStatus[] = ['unknown', 'pending', 'running', 'failed', 'approved', 'success', 'retrying']

export function isTestStatus(value: string): value is TestStatus {
  return testStatuses.some((s) => s === value)
}

const statusUpdatesMap = new Map<TestStatus | undefined, RegExp>([
  [undefined, /(unknown|success|approved|failed|pending|running)/],
  ['unknown', /(success|approved|failed|pending|running)/],
  ['success', /(approved|failed|pending|running)/],
  ['approved', /(failed|pending|running)/],
  ['failed', /(pending|running)/],
  ['pending', /running/],
  ['running', /(success|approved|failed|pending)/],
])

export function calcStatus(oldStatus?: TestStatus, newStatus?: TestStatus): TestStatus | undefined {
  return newStatus !== undefined && statusUpdatesMap.get(oldStatus)?.test(newStatus) === true ? newStatus : oldStatus
}

export function countTestsStatus(suite: CrvyRprtrSuite): {
  successCount: number
  failedCount: number
  pendingCount: number
  approvedCount: number
} {
  let successCount = 0
  let failedCount = 0
  let approvedCount = 0
  let pendingCount = 0
  const cases: (CrvyRprtrSuite | CrvyRprtrTest)[] = getChildrenArray(suite.children)
  let suiteOrTest
  while ((suiteOrTest = cases.pop())) {
    if (isTest(suiteOrTest)) {
      if (!hasScreenshots(suiteOrTest)) continue
      if (suiteOrTest.status === 'approved') approvedCount++
      if (suiteOrTest.status === 'success') successCount++
      if (suiteOrTest.status === 'failed') failedCount++
      if (suiteOrTest.status === 'pending') pendingCount++
    } else {
      cases.push(...getChildrenArray(suiteOrTest.children))
    }
  }
  return { approvedCount, successCount, failedCount, pendingCount }
}

export function getFailedTests(suite: CrvyRprtrSuite): CrvyRprtrTest[] {
  return getChildrenArray(suite.children).flatMap((suiteOrTest) => {
    if (isTest(suiteOrTest)) return suiteOrTest.status === 'failed' ? suiteOrTest : []
    return getFailedTests(suiteOrTest)
  })
}

export function getCheckedTests(suite: CrvyRprtrSuite): CrvyRprtrTest[] {
  return getChildrenArray(suite.children).flatMap((suiteOrTest) => {
    if (isTest(suiteOrTest)) return suiteOrTest.checked ? suiteOrTest : []
    if (!suiteOrTest.checked && !suiteOrTest.indeterminate) return []
    return getCheckedTests(suiteOrTest)
  })
}

export function hasScreenshots(item: CrvyRprtrSuite | CrvyRprtrTest): boolean {
  if (isTest(item)) {
    return item.results?.some((r) => r.images !== undefined && Object.keys(r.images).length > 0) ?? false
  }
  return getChildrenArray(item.children).some((child) => hasScreenshots(child))
}
