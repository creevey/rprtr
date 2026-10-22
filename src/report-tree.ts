import type { TestData } from './types'

/** Prefix marking tests synthesized from pre-run discovery rather than a real run. */
export const DISCOVERED_ID_PREFIX = 'discovered:'

/**
 * Fallback leaf key used when a test's `browser` field is empty. This only
 * happens for data produced by older reporters (before browser-label
 * resolution), where Playwright's implicit default project produced an empty
 * project name. Keeping tree creation, live sync, and selection aligned on this
 * sentinel ensures updates reach tests that would otherwise be dropped by
 * empty-browser guards.
 */
export const DEFAULT_BROWSER_KEY = 'default'

export type TreePathTest = Pick<TestData, 'browser' | 'title' | 'titlePath' | 'fileTokens'>

/**
 * Returns the leaf key for a test in the tree, substituting a sentinel for
 * empty browser strings (only possible for data from older reporters) so the
 * key is always non-empty and structural updates can find the same node.
 */
export function browserKeyFor(browser: string): string {
  return browser === '' ? DEFAULT_BROWSER_KEY : browser
}

/** Storybook uses `/` inside a single kind or story title to express nesting. */
function splitAuthoredSegment(segment: string): string[] {
  return segment
    .split('/')
    .map((part) => part.trim())
    .filter((part) => part !== '')
}

/**
 * The sidebar path of a test: its authored title path and title, split on `/`,
 * followed by the project leaf. This is the authoritative hierarchy for tree
 * construction, live updates, and selection.
 */
export function testTreePath(test: TreePathTest): string[] {
  const titlePath = test.titlePath ?? []
  const authoredTokens = [...titlePath.flatMap(splitAuthoredSegment), ...splitAuthoredSegment(test.title)]
  const isAuthored = titlePath.length > 0 || test.title.includes('/')
  const fileTokens = isAuthored ? [] : (test.fileTokens ?? [])
  return [...fileTokens, ...authoredTokens, browserKeyFor(test.browser ?? '')].filter((token) => token !== '')
}

export interface TreePathCollision {
  /** The shared rendered sidebar path, including the project leaf. */
  path: string[]
  /** Distinct tests occupying that path, ordered by id. */
  tests: Array<{ id: string; title: string }>
}

/**
 * Finds tests that resolve to the exact same rendered sidebar path. Two tests
 * in one slot cannot both be shown by the one-row-per-project tree, so callers
 * surface a warning instead of silently losing one. Discovered placeholders are
 * excluded: a discovered test and its live replacement intentionally share a
 * slot during discovery.
 */
export function findTreePathCollisions(tests: Record<string, TestData>): TreePathCollision[] {
  const groups = new Map<string, Map<string, TestData>>()
  for (const test of Object.values(tests)) {
    if (test === undefined || test.id.startsWith(DISCOVERED_ID_PREFIX)) continue
    const key = testTreePath(test).join('\u0000')
    const group = groups.get(key) ?? new Map<string, TestData>()
    group.set(test.id, test)
    groups.set(key, group)
  }

  const collisions: TreePathCollision[] = []
  for (const group of groups.values()) {
    if (group.size < 2) continue
    const [first] = group.values()
    if (first === undefined) continue
    collisions.push({
      path: testTreePath(first),
      tests: [...group.values()]
        .map(({ id, title }) => ({ id, title }))
        .sort((left, right) => left.id.localeCompare(right.id)),
    })
  }
  return collisions.sort((left, right) => left.path.join('\u0000').localeCompare(right.path.join('\u0000')))
}

/** Human-readable warning naming the shared path and every colliding test. */
export function formatTreePathCollision(collision: TreePathCollision): string {
  const tests = collision.tests.map(({ id, title }) => `"${title}" (${id})`).join(', ')
  return `Tree path collision at "${collision.path.join('/')}": ${tests}`
}

function collisionSignature(collision: TreePathCollision): string {
  return [collision.path.join('\u0000'), ...collision.tests.map(({ id }) => id)].join('\u0000')
}

/**
 * Warns about each distinct collision once per server session or page load.
 * Callers keep the reported-signature set so repeated events for the same
 * group do not repeat the warning. Warnings never alter the report.
 */
export function warnTreePathCollisions(
  tests: Record<string, TestData>,
  reportedSignatures: Set<string>,
  warn: (message: string) => void,
): void {
  for (const collision of findTreePathCollisions(tests)) {
    const signature = collisionSignature(collision)
    if (reportedSignatures.has(signature)) continue
    reportedSignatures.add(signature)
    warn(formatTreePathCollision(collision))
  }
}
