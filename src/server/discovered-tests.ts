import { dirname } from 'path'

import type { ClientWebSocketMessage, TestData } from '../types.ts'
import type { ListResult } from './list-spawn.ts'
import { runPlaywrightList, synthesizePlaywrightDiscoveredTests } from './playwright-discovery.ts'
import type { RunContext } from './run-controller.ts'
import { runVitestList, synthesizeDiscoveredTests } from './vitest-discovery.ts'

/** Prefix marking test ids synthesized from discovery rather than a real run. */
export const DISCOVERED_ID_PREFIX = 'discovered:'

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
 * The persisted view of the report state: discovered-but-never-run entries are
 * filtered out so report.json — and through it offline JSON review and the
 * static HTML artifact — stays derived from actual run events only.
 */
export function withoutDiscoveredTests<T extends { tests: Record<string, TestData> }>(data: T): T {
  if (!hasDiscoveredIds(data.tests)) return data
  return { ...data, tests: filterDiscoveredIds(data.tests) }
}

function hasDiscoveredIds(tests: Record<string, TestData>): boolean {
  return Object.keys(tests).some((id) => id.startsWith(DISCOVERED_ID_PREFIX))
}

function filterDiscoveredIds(tests: Record<string, TestData>): Record<string, TestData> {
  return Object.fromEntries(Object.entries(tests).filter(([id]) => !id.startsWith(DISCOVERED_ID_PREFIX)))
}

interface DiscoveryRunner {
  label: string
  /** Collection-only listing command, used in the failure log line. */
  command: string
}

function discoveryRunner(runContext: RunContext): DiscoveryRunner {
  return runContext.runner === 'vitest'
    ? { label: 'VitestDiscovery', command: 'vitest list' }
    : { label: 'PlaywrightDiscovery', command: 'playwright test --list' }
}

/** Log label for the run context's startup listing, shared by the failure log. */
export function discoveryLogLabel(runContext: RunContext | undefined): string {
  return runContext === undefined ? 'PlaywrightDiscovery' : discoveryRunner(runContext).label
}

export interface SeedDiscoveredTestsDeps {
  runContext: RunContext | undefined
  reportData: { isRunning: boolean; tests: Record<string, TestData>; isUpdateMode: boolean }
  broadcast: (message: ClientWebSocketMessage) => void
  /** Listing seam for tests; defaults to the runner-specific collection-only lister. */
  list?: DiscoveryListing
}

/** Runner-specific listing that returns discovered tests, or why listing failed. */
export type DiscoveryListing = (runContext: RunContext) => Promise<ListResult<TestData>>

/**
 * Runs the runner's collection-only listing and maps successful entries onto
 * discovered tests. An absent runner means Playwright, as elsewhere.
 */
async function listDiscoveredTests(runContext: RunContext): Promise<ListResult<TestData>> {
  if (runContext.runner === 'vitest') {
    const result = await runVitestList({ configFile: runContext.configFile, cwd: runContext.cwd })
    return result.ok ? { ok: true, entries: synthesizeDiscoveredTests(result.entries, runContext.cwd) } : result
  }
  const result = await runPlaywrightList({ configFile: runContext.configFile, cwd: runContext.cwd })
  // The reporter groups by config-dir-relative file tokens, so discovery does too.
  return result.ok
    ? { ok: true, entries: synthesizePlaywrightDiscoveredTests(result.entries, dirname(runContext.configFile)) }
    : result
}

/**
 * One-shot startup listing for the seeded run context: enumerates the project's
 * tests and merges them into the report tree as `pending`. Fire-and-forget from
 * the caller's perspective — the server is interactive before this lands, and a
 * failed or empty listing only logs, leaving the discovered run controls enabled
 * and the loaded report untouched.
 */
export async function seedDiscoveredTests(deps: SeedDiscoveredTestsDeps): Promise<void> {
  const runContext = deps.runContext
  if (runContext === undefined) return

  const result = await (deps.list ?? listDiscoveredTests)(runContext)
  // A run that started while the listing was in flight replaces the whole tree;
  // discovered state must never be injected into an active run.
  if (deps.reportData.isRunning) return
  if (!result.ok) {
    const { label, command } = discoveryRunner(runContext)
    console.error(
      `[${label}] \`${command}\` failed (${result.reason}); run controls stay enabled and the sidebar keeps its loaded state`,
    )
    return
  }
  if (result.entries.length === 0) {
    const { label, command } = discoveryRunner(runContext)
    console.error(
      `[${label}] \`${command}\` returned no tests; run controls stay enabled and the sidebar keeps its loaded state`,
    )
    return
  }
  const changed = mergeDiscoveredTests(deps.reportData, result.entries)
  if (!changed) return
  deps.broadcast({
    type: 'sync',
    data: { tests: deps.reportData.tests, isUpdateMode: deps.reportData.isUpdateMode },
  })
}
