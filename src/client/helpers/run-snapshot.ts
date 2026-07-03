import { type CrvyRprtrSuite, type CrvyRprtrTest, type TestStatus, isTest, getChildrenArray } from '../../types'

/** Captures testId -> current status for every test under `node` (including `undefined`). */
export function captureTestStatuses(node: CrvyRprtrSuite | CrvyRprtrTest): Map<string, TestStatus | undefined> {
  const snapshot = new Map<string, TestStatus | undefined>()
  const walk = (n: CrvyRprtrSuite | CrvyRprtrTest): void => {
    if (isTest(n)) {
      snapshot.set(n.id, n.status)
      return
    }
    for (const child of getChildrenArray(n.children)) walk(child)
  }
  walk(node)
  return snapshot
}

/**
 * Restores `test.status` for every test under `root` whose id is in `snapshot`
 * and NOT in `receivedIds`. Leaves tests that did receive an event untouched.
 * Returns the number of tests restored.
 */
export function restoreTestStatuses(
  root: CrvyRprtrSuite,
  snapshot: Map<string, TestStatus | undefined>,
  receivedIds: Set<string>,
): number {
  let restored = 0
  const walk = (n: CrvyRprtrSuite | CrvyRprtrTest): void => {
    if (isTest(n)) {
      if (snapshot.has(n.id) && !receivedIds.has(n.id)) {
        n.status = snapshot.get(n.id)
        restored++
      }
      return
    }
    for (const child of getChildrenArray(n.children)) walk(child)
  }
  walk(root)
  return restored
}
