import { dirname } from 'path'

import type { ClientWebSocketMessage, TestData } from '../types.ts'
import type { ListResult } from './list-spawn.ts'
import { runPlaywrightList, synthesizePlaywrightDiscoveredTests } from './playwright-discovery.ts'
import type { ReportData } from './report-bootstrap.ts'
import type { RunContext } from './run-controller.ts'
import { createTestFileWatcher, type TestFileWatcher, type WatchFn } from './test-file-watcher.ts'
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
  if (!hasDiscoveredIds(data.tests)) return data
  return { ...data, tests: filterDiscoveredIds(data.tests) }
}

function isDiscoveredId(id: string): boolean {
  return id.startsWith(DISCOVERED_ID_PREFIX)
}

function hasDiscoveredIds(tests: Record<string, TestData>): boolean {
  return Object.keys(tests).some(isDiscoveredId)
}

function filterDiscoveredIds(tests: Record<string, TestData>): Record<string, TestData> {
  return Object.fromEntries(Object.entries(tests).filter(([id]) => !isDiscoveredId(id)))
}

/** The report fields the discovery pipeline reads and mutates. */
export type DiscoveryReportData = Pick<ReportData, 'isRunning' | 'tests' | 'isUpdateMode'>

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

/** Absolute files named by a listing, used as the watcher's directory roots. */
function listedFiles(tests: readonly TestData[]): string[] {
  return tests.map((test) => test.location?.file).filter((file): file is string => file !== undefined && file !== '')
}

/** One line describing a startup listing outcome; the suffix keeps controls/runs unaffected. */
function logStartupListing(runContext: RunContext, detail: string, log: (message: string) => void): void {
  const { label, command } = discoveryRunner(runContext)
  log(`[${label}] \`${command}\` ${detail}; run controls stay enabled and the sidebar keeps its loaded state`)
}

function broadcastSync(deps: {
  reportData: DiscoveryReportData
  broadcast: (message: ClientWebSocketMessage) => void
}): void {
  deps.broadcast({ type: 'sync', data: { tests: deps.reportData.tests, isUpdateMode: deps.reportData.isUpdateMode } })
}

export interface SeedDiscoveredTestsDeps {
  runContext: RunContext | undefined
  reportData: DiscoveryReportData
  broadcast: (message: ClientWebSocketMessage) => void
  /** Listing seam for tests; defaults to the runner-specific collection-only lister. */
  list?: DiscoveryListing
  /** Log sink for failures and empty listings; defaults to console.error. */
  log?: (message: string) => void
}

/**
 * One-shot startup listing for the seeded run context: enumerates the project's
 * tests and merges them into the report tree as `pending`. Returns the listing
 * result so a session can widen its watch roots afterwards; null when there is
 * no run context or a run preempted the merge. A failed or empty listing only
 * logs, leaving the run controls enabled and the loaded report untouched.
 */
export async function seedDiscoveredTests(deps: SeedDiscoveredTestsDeps): Promise<ListResult<TestData> | null> {
  const runContext = deps.runContext
  if (runContext === undefined) return null
  const log = deps.log ?? console.error

  const result = await (deps.list ?? listDiscoveredTests)(runContext)
  // A run that started while the listing was in flight replaces the whole tree;
  // discovered state must never be injected into an active run.
  if (deps.reportData.isRunning) return null
  if (!result.ok) {
    logStartupListing(runContext, `failed (${result.reason})`, log)
    return result
  }
  if (result.entries.length === 0) {
    logStartupListing(runContext, 'returned no tests', log)
    return result
  }
  if (mergeDiscoveredTests(deps.reportData, result.entries)) broadcastSync(deps)
  return result
}

export interface DiscoverySessionDeps {
  runContext: RunContext
  reportData: DiscoveryReportData
  broadcast: (message: ClientWebSocketMessage) => void
  /** Listing seam for tests; defaults to the runner-specific collection-only lister. */
  list?: DiscoveryListing
  /** Filesystem watch seam; defaults to the real `fs.watch`. */
  watch?: WatchFn
  /** Absolute files or directories whose changes never schedule a refresh. */
  ignore?: readonly string[]
  /** Trailing debounce for change bursts. */
  debounceMs?: number
  /** Log sink for failures and watcher degradation; defaults to console.error. */
  log?: (message: string) => void
}

export interface DiscoverySession {
  /** Flushes a refresh that was queued while a run was in progress. */
  notifyRunSettled(): void
  /** Stops watching and cancels scheduled re-enumerations. */
  dispose(): void
}

/** Serialized refresh pipeline: one re-enumeration at a time, coalesced follow-ups, run deferral. */
class DiscoverySessionState implements DiscoverySession {
  private readonly watcher: TestFileWatcher
  private readonly log: (message: string) => void
  private inFlight = false
  private dirty = true
  private initial = true
  private disposed = false

  constructor(private readonly deps: DiscoverySessionDeps) {
    this.log = deps.log ?? console.error
    this.watcher = createTestFileWatcher({
      runContext: deps.runContext,
      watch: deps.watch,
      ignore: deps.ignore,
      debounceMs: deps.debounceMs,
      log: this.log,
      onChange: (): void => {
        this.markDirty()
      },
    })
    this.pump()
  }

  notifyRunSettled(): void {
    this.pump()
  }

  dispose(): void {
    this.disposed = true
    this.watcher.dispose()
  }

  private markDirty(): void {
    if (this.disposed) return
    this.dirty = true
    this.pump()
  }

  private pump(): void {
    if (this.disposed || this.inFlight || !this.dirty || this.deps.reportData.isRunning) return
    this.dirty = false
    this.inFlight = true
    const initial = this.initial
    this.initial = false
    void (initial ? this.runInitialListing() : this.runRefresh()).finally(() => {
      this.inFlight = false
      if (this.dirty) this.pump()
    })
  }

  private async runInitialListing(): Promise<void> {
    const { runContext, reportData, broadcast, list } = this.deps
    const result = await seedDiscoveredTests({ runContext, reportData, broadcast, list, log: this.log })
    if (this.disposed || result === null || !result.ok) return
    this.watcher.updateListedFiles(listedFiles(result.entries))
  }

  private async runRefresh(): Promise<void> {
    const { deps } = this
    const result = await (deps.list ?? listDiscoveredTests)(deps.runContext)
    if (this.disposed) return
    if (!result.ok) {
      const { label } = discoveryRunner(deps.runContext)
      this.log(`[${label}] refresh listing failed (${result.reason}); keeping the current tree`)
      return
    }
    if (deps.reportData.isRunning) {
      this.dirty = true
      return
    }
    const changed = reconcileDiscoveredTests(deps.reportData, result.entries)
    this.watcher.updateListedFiles(listedFiles(result.entries))
    if (changed) broadcastSync(deps)
  }
}

export function startDiscoverySession(deps: DiscoverySessionDeps): DiscoverySession {
  return new DiscoverySessionState(deps)
}
