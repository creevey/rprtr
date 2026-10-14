import type { PinBrowser, ResolvedProjectPin } from '../browser-pins.ts'
import type { DebugLogger } from '../debug-log.ts'
import type { RunTestDescriptor } from '../schemas.ts'
import type { ClientWebSocketMessage } from '../types.ts'
import type { BrowserSidecar } from './browser-sidecar.ts'
import type { ContainerPathMapping } from './docker-support.ts'
import type { RunLauncher } from './run-launcher.ts'
import type { RunMode } from './run-mode.ts'

/**
 * Terminal sinks shared by the controller and its lifecycle records. Both are
 * optional so tests can capture output instead of hitting the console.
 */
export interface RecordSinks {
  /** Warning sink for run-mode fallbacks and non-zero terminations; defaults to console.warn. */
  warn?: (message: string) => void
  /** Terminal sink for run launch/exit records; defaults to console.log. */
  log?: (message: string) => void
}

export type RunnerKind = 'playwright' | 'vitest'

export interface RunContext {
  configFile: string
  cwd: string
  /** Playwright's rootDir — the base --test-list entries are matched against. */
  rootDir?: string
  /** Which runner kind this context launches. Absent means Playwright (old registers, seeded contexts). */
  runner?: RunnerKind
}

export interface RunFilters {
  tests?: RunTestDescriptor[]
  update?: boolean
}

export type StartResult =
  | { ok: true }
  | {
      ok: false
      reason: 'no-config' | 'already-running' | 'no-tests' | 'docker-unavailable' | 'docker-missing-browser-hook'
    }

export type StopResult = { ok: true } | { ok: false; reason: 'not-running' }

export interface ChildProcessLike {
  on(event: 'exit', cb: (code: number | null, signal?: string | null) => void): void
  on(event: 'error', cb: (err: Error) => void): void
  kill(signal: string): void
  /** Optional piped-output handles; present when the spawn piped the stream. */
  stdout?: {
    on(event: 'data', cb: (chunk: string | Buffer) => void): void
  }
  stderr?: {
    on(event: 'data', cb: (chunk: string | Buffer) => void): void
  }
}

export interface SpawnLike {
  (cmd: string, args: string[], opts: Record<string, unknown>): ChildProcessLike
}

export interface RunControllerDeps extends RecordSinks {
  getRunContext(): RunContext | null
  port: number
  broadcast(message: ClientWebSocketMessage): void
  setReportRunning(running: boolean): void
  /** Server-side debug channel: launch vectors, capture records, and injection into spawns. */
  debug?: DebugLogger
  /** Records whether the in-progress run is filtered, so run-end can preserve unrelated tests. */
  setRunFiltered?(filtered: boolean): void
  /** Invoked when the child exits, so a discovery refresh queued during the run can apply. */
  notifyRunSettled?: () => void
  containerPathMapping?: ContainerPathMapping
  /** Flushes pending report writes on child exit so an interrupted run still persists. */
  saveReport?: () => Promise<void>
  spawn: SpawnLike
  timers: {
    setTimeout: (fn: () => void, ms?: number) => unknown
    clearTimeout: (handle: unknown) => void
  }
  resolveReporter?: (cwd: string) => string | null
  /** Builds the launch command and environment for a run. */
  launcher: RunLauncher
  /** Configured run mode; Vitest runs compose with the browser sidecar in docker/auto modes. */
  getRunMode?: () => RunMode | undefined
  /** Always-local launcher used when a Vitest run must skip the docker backend. */
  localLauncher?: RunLauncher
  /** Warm browser sidecar backing docker-mode Vitest runs. */
  browserSidecar?: BrowserSidecar
  /** Reads declared Vitest pins for the sidecar preflight; defaults to the project's Vitest config. */
  readVitestPins?: (cwd: string) => Promise<readonly ResolvedProjectPin[]>
  /** Installed browser executable paths for the Vitest pin preflight; defaults to the project's Playwright. */
  browserExecutablePaths?: (cwd: string) => Record<PinBrowser, string> | null
  /** Vitest config hook scan; defaults to the textual `CRVY_RPRTR_BROWSER_WS` scan. */
  hasBrowserHook?: (configFile: string) => boolean
  /** Clock seam for run duration records; defaults to Date.now. */
  now?: () => number
  /** Injectable seams for the version-gated `--test-list` path (Playwright >= 1.56). */
  getPlaywrightVersion?: (cwd: string) => string | null
  writeTempFile?: (content: string) => string
  deleteTempFile?: (path: string) => void
}
