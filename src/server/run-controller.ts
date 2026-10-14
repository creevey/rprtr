import { resolvePlaywrightVersion } from '../browser-pins.ts'
import { DEBUG_ENV, formatEnvironment, formatRecord } from '../debug-log.ts'
import { DOCKER_IMAGE_ENV } from '../docker-image.ts'
import type { RunTestDescriptor } from '../schemas.ts'
import { BROWSER_WS_ENV } from './browser-sidecar.ts'
import { rewriteContainerTestDescriptors } from './docker-support.ts'
import { attachRunCapture, type RunCapture } from './run-capture.ts'
import {
  buildPlaywrightRunArgs,
  defaultDeleteTempFile,
  defaultWriteTempFile,
  gteMinor,
  resolveReporterDefault,
} from './run-command-helpers.ts'
import type {
  ChildProcessLike,
  RunContext,
  RunControllerDeps,
  RunFilters,
  SpawnLike,
  StartResult,
  StopResult,
} from './run-controller-types.ts'
import type { RunLauncher, LaunchSpec } from './run-launcher.ts'
import { prepareRunForContext } from './run-preparation.ts'
import { createRealSpawn, createRealTimers } from './run-process.ts'
import { emitExitRecord, emitLog, emitWarn, renderLaunchRecord } from './run-records.ts'
import { buildVitestArgs, resolveVitestLaunchPlan } from './vitest-backend.ts'

export type {
  ChildProcessLike,
  RecordSinks,
  RunContext,
  RunControllerDeps,
  RunFilters,
  RunnerKind,
  SpawnLike,
  StartResult,
  StopResult,
} from './run-controller-types.ts'
export { resolvePlaywrightLaunch } from './run-launcher.ts'
export { buildTestListEntries } from './docker-support.ts'
export { resolvePlaywrightVersion } from '../browser-pins.ts'
export { createRealSpawn, createRealTimers } from './run-process.ts'

const STOP_GRACE_MS = 5000

export class RunController {
  private child: ChildProcessLike | null = null
  private childLauncher: RunLauncher | null = null
  private childMode: 'local' | 'docker' | null = null
  private sigkillTimer: unknown = null
  private testListPath: string | null = null
  /** Debug-only mirrored stdout/stderr capture of the running child. */
  private capture: RunCapture | null = null
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
    for (const notice of notices) emitWarn(this.deps, notice)
  }

  /**
   * Registers the child lifecycle handlers. The spawn time is captured here so
   * exit records measure the run itself, not controller uptime.
   */
  private watchChild(child: ChildProcessLike, startedAt: number): void {
    child.on('exit', (code, signal) => {
      this.handleChildExit(code, signal, startedAt)
    })
    child.on('error', () => {
      this.handleChildExit(null, undefined, startedAt)
    })
  }

  /**
   * Adopts a freshly spawned child: records it as the running child, attaches
   * the debug capture (only when stdio was piped), and registers lifecycle
   * handlers.
   */
  private adoptChild(
    child: ChildProcessLike,
    launcher: RunLauncher,
    mode: 'local' | 'docker',
    startedAt: number,
  ): void {
    this.child = child
    this.childLauncher = launcher
    this.childMode = mode
    const debug = this.deps.debug?.enabled === true ? this.deps.debug : null
    if (debug !== null) this.capture = attachRunCapture(child, debug)
    this.watchChild(child, startedAt)
  }

  /**
   * Debug-only launch-vector record: the exact command and arguments and the
   * child's environment names, with values only from the redaction allowlist.
   * Emitted before the spawn so a synchronous spawn failure stays attributable.
   */
  private emitDebugLaunch(spec: LaunchSpec, spawnEnv: Record<string, string | undefined>): void {
    const debug = this.deps.debug
    if (debug?.enabled !== true) return
    debug.log(
      formatRecord('RunController', {
        event: 'launch',
        cmd: spec.cmd,
        args: spec.args.join(' '),
        env: formatEnvironment(spawnEnv),
      }),
    )
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
    emitLog(this.deps, renderLaunchRecord(mode, ctx, filters, spec, tests))
    const startedAt = (this.deps.now ?? Date.now)()
    const debug = this.deps.debug?.enabled === true ? this.deps.debug : null
    const spawnEnv = debug === null ? spec.env : { ...spec.env, [DEBUG_ENV]: '1' }
    this.emitDebugLaunch(spec, spawnEnv)
    let child: ChildProcessLike
    try {
      child = this.deps.spawn(spec.cmd, spec.args, {
        cwd: ctx.cwd,
        env: spawnEnv,
        stdio: debug === null ? 'inherit' : ['ignore', 'pipe', 'pipe'],
      })
    } catch (err) {
      this.cleanupTempFile()
      throw err
    }
    this.adoptChild(child, launcher, mode, startedAt)
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

  private handleChildExit(code: number | null, signal?: string | null, startedAt?: number): void {
    if (this.child === null) return
    if (this.sigkillTimer !== null) this.deps.timers.clearTimeout(this.sigkillTimer)
    this.sigkillTimer = null
    this.child = null
    this.capture?.settle()
    this.capture = null
    const launcher = this.childLauncher ?? this.deps.launcher
    const mode = this.childMode ?? launcher.mode
    this.childLauncher = null
    this.childMode = null
    this.cleanupTempFile()
    const endedAt = (this.deps.now ?? Date.now)()
    emitExitRecord(this.deps, code, signal, endedAt - (startedAt ?? endedAt))
    this.deps.setReportRunning(false)
    this.deps.broadcast({ type: 'run-status', data: { running: false, mode } })
    this.deps.notifyRunSettled?.()
    void this.deps.saveReport?.()
  }
}
