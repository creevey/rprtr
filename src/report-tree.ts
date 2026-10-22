import type { TestData } from './types'

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
