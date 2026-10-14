import { dirname } from 'path'

import type { DebugLogger } from '../debug-log.ts'
import type { ClientWebSocketMessage, TestData } from '../types.ts'
import { mergeDiscoveredTests, reconcileDiscoveredTests } from './discovered-merge.ts'
import type { ListResult } from './list-spawn.ts'
import { runPlaywrightList, synthesizePlaywrightDiscoveredTests } from './playwright-discovery.ts'
import type { ReportData } from './report-bootstrap.ts'
import type { RunContext } from './run-controller.ts'
import { createTestFileWatcher, type TestFileWatcher, type WatchFn } from './test-file-watcher.ts'
import { runVitestList, synthesizeDiscoveredTests } from './vitest-discovery.ts'

export {
  DISCOVERED_ID_PREFIX,
  discoveredTestIdentity,
  mergeDiscoveredTests,
  reconcileDiscoveredTests,
  withoutDiscoveredTests,
} from './discovered-merge.ts'

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

/** Binds the debug channel into the default runner-specific listing. */
function defaultListing(debug: DebugLogger | undefined): DiscoveryListing {
  return (runContext) => listDiscoveredTests(runContext, debug)
}

/**
 * Runs the runner's collection-only listing and maps successful entries onto
 * discovered tests. An absent runner means Playwright, as elsewhere.
 */
async function listDiscoveredTests(runContext: RunContext, debug?: DebugLogger): Promise<ListResult<TestData>> {
  if (runContext.runner === 'vitest') {
    const result = await runVitestList({ configFile: runContext.configFile, cwd: runContext.cwd, debug })
    return result.ok ? { ok: true, entries: synthesizeDiscoveredTests(result.entries, runContext.cwd) } : result
  }
  const result = await runPlaywrightList({ configFile: runContext.configFile, cwd: runContext.cwd, debug })
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
  /** Server-side debug channel for listing records and activation propagation. */
  debug?: DebugLogger
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

  const result = await (deps.list ?? defaultListing(deps.debug))(runContext)
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
  /** Server-side debug channel for listing records and activation propagation. */
  debug?: DebugLogger
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
    const pipeline = initial ? this.runInitialListing() : this.runRefresh()
    void pipeline
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        this.log(`[${discoveryRunner(this.deps.runContext).label}] discovery failed: ${message}`)
      })
      .finally(() => {
        this.inFlight = false
        if (this.dirty) this.pump()
      })
  }

  private async runInitialListing(): Promise<void> {
    const { runContext, reportData, broadcast, list, debug } = this.deps
    const result = await seedDiscoveredTests({ runContext, reportData, broadcast, list, log: this.log, debug })
    if (this.disposed || result === null || !result.ok) return
    this.watcher.updateListedFiles(listedFiles(result.entries))
  }

  private async runRefresh(): Promise<void> {
    const { deps } = this
    const result = await (deps.list ?? defaultListing(deps.debug))(deps.runContext)
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
