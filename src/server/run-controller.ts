import { resolvePlaywrightVersion, type PinBrowser, type ResolvedProjectPin } from '../browser-pins.ts'
import { DOCKER_IMAGE_ENV } from '../docker-image.ts'
import type { RunTestDescriptor } from '../schemas.ts'
import type { ClientWebSocketMessage } from '../types.ts'
import { BROWSER_WS_ENV, type BrowserSidecar } from './browser-sidecar.ts'
import { rewriteContainerTestDescriptors, type ContainerPathMapping } from './docker-support.ts'
import {
  buildPlaywrightRunArgs,
  defaultDeleteTempFile,
  defaultWriteTempFile,
  gteMinor,
  resolveReporterDefault,
} from './run-command-helpers.ts'
import { type RunLauncher } from './run-launcher.ts'
import type { RunMode } from './run-mode.ts'
import { prepareRunForContext } from './run-preparation.ts'
import { createRealSpawn, createRealTimers } from './run-process.ts'
import { buildVitestArgs, resolveVitestLaunchPlan } from './vitest-backend.ts'

export { resolvePlaywrightLaunch } from './run-launcher.ts'
export { buildTestListEntries } from './docker-support.ts'
export { resolvePlaywrightVersion } from '../browser-pins.ts'
export { createRealSpawn, createRealTimers } from './run-process.ts'

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
  on(event: 'exit', cb: (code: number | null) => void): void
  on(event: 'error', cb: (err: Error) => void): void
  kill(signal: string): void
}

export interface SpawnLike {
  (cmd: string, args: string[], opts: Record<string, unknown>): ChildProcessLike
}

export interface RunControllerDeps {
  getRunContext(): RunContext | null
  port: number
  broadcast(message: ClientWebSocketMessage): void
  setReportRunning(running: boolean): void
  /** Records whether the in-progress run is filtered, so run-end can preserve unrelated tests. */
  setRunFiltered?(filtered: boolean): void
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
  /** Warning sink for run-mode fallbacks; defaults to console.warn. */
  warn?: (message: string) => void
  /** Injectable seams for the version-gated `--test-list` path (Playwright >= 1.56). */
  getPlaywrightVersion?: (cwd: string) => string | null
  writeTempFile?: (content: string) => string
  deleteTempFile?: (path: string) => void
}

const STOP_GRACE_MS = 5000

export class RunController {
  private child: ChildProcessLike | null = null
  private childLauncher: RunLauncher | null = null
  private childMode: 'local' | 'docker' | null = null
  private sigkillTimer: unknown = null
  private testListPath: string | null = null
  /** Ready sidecar endpoint from the last successful prepareRun, reused across runs. */
  private browserWs: string | null = null
  /** Image of the sidecar backing the current Vitest run, exported for offline pin resolution. */
  private browserImage: string | null = null
  /** Host-service divergence notices collected by the last prepareRun, broadcast with the run. */
  private runNotices: string[] = []

  constructor(private readonly deps: RunControllerDeps) {}

  get isRunning(): boolean {
    return this.child !== null
  }

  private supportsTestList(cwd: string): boolean {
    const getVersion = this.deps.getPlaywrightVersion ?? resolvePlaywrightVersion
    const version = getVersion(cwd)
    return version !== null && gteMinor(version, 1, 56)
  }

  private cleanupTempFile(): void {
    if (this.testListPath !== null) {
      const del = this.deps.deleteTempFile ?? defaultDeleteTempFile
      del(this.testListPath)
      this.testListPath = null
    }
  }

  private buildPlaywrightArgs(ctx: RunContext, filters: RunFilters, tests: RunTestDescriptor[] | undefined): string[] {
    const resolveReporter = this.deps.resolveReporter ?? resolveReporterDefault
    const containerMode = this.deps.containerPathMapping !== undefined
    const useTestList = tests !== undefined && (tests.length > 1 || containerMode) && this.supportsTestList(ctx.cwd)

    const built = buildPlaywrightRunArgs({
      configFile: ctx.configFile,
      cwd: ctx.cwd,
      rootDir: ctx.rootDir,
      update: filters.update === true,
      tests,
      reporterModule: resolveReporter(ctx.cwd),
      useTestList,
      pathStyle: containerMode ? 'posix' : 'host',
      writeTempFile: this.deps.writeTempFile ?? defaultWriteTempFile,
    })
    this.testListPath = built.testListPath
    return built.args
  }

  /**
   * Resolves the launcher and run mode for a start request. Vitest runs fall
   * back to the always-local launcher even under the docker backend; see
   * `resolveVitestLaunchPlan` for the docker/auto decisions (D6).
   */
  private resolveLaunchPlan(
    ctx: RunContext,
  ):
    | { launcher: RunLauncher; mode: 'local' | 'docker' }
    | { refusal: 'docker-missing-browser-hook' }
    | { unavailable: true } {
    if (ctx.runner !== 'vitest') {
      return { launcher: this.deps.launcher, mode: this.deps.launcher.mode }
    }
    return resolveVitestLaunchPlan({
      ctx,
      runMode: this.deps.getRunMode?.(),
      dockerBackend: this.deps.launcher.mode === 'docker',
      warn: true,
      hasHook: this.deps.hasBrowserHook,
      warnSink: this.deps.warn,
      localLauncher: this.deps.localLauncher ?? this.deps.launcher,
      browserWs: this.browserWs,
    })
  }

  /**
   * Logs host-service divergence notices through the warning sink. Notices are
   * never persisted: they only decorate the running broadcast for the live UI.
   */
  private warnNotices(notices: readonly string[]): void {
    for (const notice of notices) {
      if (this.deps.warn === undefined) console.warn(notice)
      else this.deps.warn(notice)
    }
  }

  start(filters: RunFilters): StartResult {
    const ctx = this.deps.getRunContext()
    if (ctx === null) return { ok: false, reason: 'no-config' }
    if (this.child !== null) return { ok: false, reason: 'already-running' }
    if (filters.tests !== undefined && filters.tests.length === 0) return { ok: false, reason: 'no-tests' }

    const plan = this.resolveLaunchPlan(ctx)
    if ('refusal' in plan) return { ok: false, reason: plan.refusal }
    if ('unavailable' in plan) return { ok: false, reason: 'docker-unavailable' }
    const { launcher, mode } = plan
    if (launcher.available === false) return { ok: false, reason: 'docker-unavailable' }

    const tests = rewriteContainerTestDescriptors(filters.tests, this.deps.containerPathMapping)
    const args =
      ctx.runner === 'vitest' ? buildVitestArgs(ctx, filters, tests) : this.buildPlaywrightArgs(ctx, filters, tests)

    const spec = launcher.launch({ ctx, playwrightArgs: args })
    if (ctx.runner === 'vitest' && mode === 'docker' && this.browserWs !== null) {
      spec.env = {
        ...spec.env,
        [BROWSER_WS_ENV]: this.browserWs,
        ...(this.browserImage === null ? {} : { [DOCKER_IMAGE_ENV]: this.browserImage }),
      }
    }
    let child: ChildProcessLike
    try {
      child = this.deps.spawn(spec.cmd, spec.args, { cwd: ctx.cwd, env: spec.env, stdio: 'inherit' })
    } catch (err) {
      this.cleanupTempFile()
      throw err
    }
    this.child = child
    this.childLauncher = launcher
    this.childMode = mode
    child.on('exit', (code) => {
      this.handleChildExit(code)
    })
    child.on('error', () => {
      this.handleChildExit(null)
    })
    this.deps.setReportRunning(true)
    this.deps.setRunFiltered?.(filters.tests !== undefined)
    this.warnNotices(this.runNotices)
    this.deps.broadcast({
      type: 'run-status',
      data: { running: true, mode, ...(this.runNotices.length === 0 ? {} : { notices: this.runNotices }) },
    })
    return { ok: true }
  }

  stop(): StopResult {
    if (this.child === null) return { ok: false, reason: 'not-running' }
    if (this.sigkillTimer !== null) this.deps.timers.clearTimeout(this.sigkillTimer)
    this.child.kill('SIGTERM')
    this.sigkillTimer = this.deps.timers.setTimeout(() => {
      if (this.child !== null) {
        this.child.kill('SIGKILL')
        this.deps.launcher.onForceKill?.()
        this.deps.browserSidecar?.dispose()
      }
    }, STOP_GRACE_MS)
    return { ok: true }
  }

  async prepareRun(): Promise<{ ok: true; notices?: string[] } | { ok: false; reason: 'docker-unavailable' }> {
    const ctx = this.deps.getRunContext()
    this.runNotices = []
    if (ctx === null) return { ok: true }
    const prepared = await prepareRunForContext(ctx, this.deps)
    if (!prepared.ok) return { ok: false, reason: 'docker-unavailable' }
    if (prepared.sidecar !== undefined) {
      this.browserWs = prepared.sidecar.endpoint
      this.browserImage = prepared.sidecar.image ?? null
    }
    this.runNotices = prepared.notices ?? []
    return prepared.notices === undefined ? { ok: true } : { ok: true, notices: prepared.notices }
  }

  dispose(): void {
    this.deps.browserSidecar?.dispose()
    this.browserImage = null
    if (this.child === null) return
    if (this.sigkillTimer !== null) this.deps.timers.clearTimeout(this.sigkillTimer)
    this.sigkillTimer = null
    this.child.kill('SIGKILL')
    this.deps.launcher.onForceKill?.()
    this.cleanupTempFile()
  }

  private handleChildExit(code: number | null): void {
    if (this.child === null) return
    if (this.sigkillTimer !== null) this.deps.timers.clearTimeout(this.sigkillTimer)
    this.sigkillTimer = null
    this.child = null
    const launcher = this.childLauncher ?? this.deps.launcher
    const mode = this.childMode ?? launcher.mode
    this.childLauncher = null
    this.childMode = null
    this.cleanupTempFile()
    if (code !== null && code !== 0) console.warn(`[RunController] test run exited with code ${code}`)
    this.deps.setReportRunning(false)
    this.deps.broadcast({ type: 'run-status', data: { running: false, mode } })
    void this.deps.saveReport?.()
  }
}
