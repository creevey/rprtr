import { DISCOVERED_ID_PREFIX } from '../report-tree.ts'
import type { TestData } from '../types.ts'

export { DISCOVERED_ID_PREFIX } from '../report-tree.ts'

/**
 * Stable identity of a discovered test: (file, full title path). Survives across
 * runs, unlike runtime task ids, so discovered entries can be matched against
 * tests a loaded report already knows.
 */
export function discoveredTestIdentity(file: string, fullName: string): string {
  return `${file}\u0000${fullName}`
}

/**
 * Identity of a test as its (absolute file, full title path) tuple — the same
 * tuple whether the test came from a listing or a loaded report. Null when the
 * test carries no file to identify it by.
 */
function testIdentity(test: TestData): string | null {
  const file = test.location?.file
  if (file === undefined) return null
  return discoveredTestIdentity(file, [...test.titlePath, test.title].join(' > '))
}

/**
 * Merges discovered entries into the report state, filling only identities the
 * report does not already know — loaded results are never downgraded to pending.
 * Returns true when anything was added.
 */
export function mergeDiscoveredTests(reportData: { tests: Record<string, TestData> }, discovered: TestData[]): boolean {
  const knownIdentities = new Set<string>()
  for (const test of Object.values(reportData.tests)) {
    const identity = testIdentity(test)
    if (identity !== null) knownIdentities.add(identity)
  }

  let changed = false
  for (const test of discovered) {
    const identity = testIdentity(test)
    if (identity !== null && knownIdentities.has(identity)) continue
    if (reportData.tests[test.id] !== undefined) continue
    reportData.tests[test.id] = test
    changed = true
  }
  return changed
}

/**
 * Replaces the discovered layer with the latest listing against the loaded
 * report state: placeholders for identities the listing no longer names
 * disappear, newly listed tests are merged in as `pending`, and recorded
 * results, approvals, and run state of known tests are never downgraded or
 * duplicated. Still-listed placeholders are kept as they are, so an unchanged
 * listing reports no change. Returns true when the tree changed; a successful
 * listing with no entries clears the whole discovered layer.
 */
export function reconcileDiscoveredTests(
  reportData: { tests: Record<string, TestData> },
  discovered: TestData[],
): boolean {
  const listedIds = new Set(discovered.map((test) => test.id))
  const kept: Record<string, TestData> = {}
  let removed = false
  for (const [id, test] of Object.entries(reportData.tests)) {
    if (isDiscoveredId(id) && !listedIds.has(id)) {
      removed = true
      continue
    }
    kept[id] = test
  }
  if (removed) reportData.tests = kept
  const added = mergeDiscoveredTests(reportData, discovered)
  return added || removed
}

/**
 * The persisted view of the report state: discovered-but-never-run entries are
 * filtered out so report.json — and through it offline JSON review and the
 * static HTML artifact — stays derived from actual run events only.
 */
export function withoutDiscoveredTests<T extends { tests: Record<string, TestData> }>(data: T): T {
  const entries = Object.entries(data.tests)
  if (!entries.some(([id]) => isDiscoveredId(id))) return data
  return { ...data, tests: Object.fromEntries(entries.filter(([id]) => !isDiscoveredId(id))) }
}

function isDiscoveredId(id: string): boolean {
  return id.startsWith(DISCOVERED_ID_PREFIX)
}
