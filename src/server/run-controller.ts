import type { RunTestDescriptor } from '../schemas.ts'
import type { ClientWebSocketMessage } from '../types.ts'
import {
  buildTestListEntries,
  rewriteContainerTestDescriptors,
  resolvePlaywrightVersion,
  type ContainerPathMapping,
} from './docker-support.ts'
import {
  defaultDeleteTempFile,
  defaultWriteTempFile,
  gteMinor,
  resolveReporterDefault,
  sharedProject,
} from './run-command-helpers.ts'
import { type RunLauncher } from './run-launcher.ts'
import type { RunMode } from './run-mode.ts'
import { createRealSpawn, createRealTimers } from './run-process.ts'

export { resolvePlaywrightLaunch } from './run-launcher.ts'
export { buildTestListEntries } from './docker-support.ts'
export { resolvePlaywrightVersion } from './docker-support.ts'
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
      reason: 'no-config' | 'already-running' | 'no-tests' | 'docker-unavailable' | 'docker-unsupported-for-runner'
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
  /** Called after a run spawns successfully; drops stale discovered entries before events stream. */
  onRunStart?: () => void
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
  /** Configured run mode; Vitest runs only ever launch locally (D5). */
  getRunMode?: () => RunMode | undefined
  /** Always-local launcher used when a Vitest run must skip the docker backend. */
  localLauncher?: RunLauncher
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
  private sigkillTimer: unknown = null
  private testListPath: string | null = null

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
    const reporterModule = resolveReporter(ctx.cwd)
    // Docker: positional host file:line filters cannot resolve in-container — use --test-list for any count.
    const useTestList =
      tests !== undefined &&
      (tests.length > 1 || this.deps.containerPathMapping !== undefined) &&
      this.supportsTestList(ctx.cwd)

    const args = ['test', '--config', ctx.configFile]
    if (reporterModule !== null) args.push('--reporter', reporterModule)
    if (filters.update === true) args.push('--update-snapshots')
    if (useTestList && tests !== undefined) {
      const content = buildTestListEntries(
        tests,
        ctx.rootDir,
        ctx.cwd,
        this.deps.containerPathMapping === undefined ? 'host' : 'posix',
      ).join('\n')
      const writeTemp = this.deps.writeTempFile ?? defaultWriteTempFile
      this.testListPath = writeTemp(content)
      args.push('--test-list', this.testListPath)
    } else if (tests !== undefined && tests.length > 0) {
      const project = sharedProject(tests)
      // `--project=name` not `--project name`: --project is variadic, so the space form swallows
      // the next positional filter as another project name ("Project not found").
      if (project !== undefined) args.push(`--project=${project}`)
      for (const d of tests) {
        args.push(d.column === undefined ? `${d.file}:${d.line}` : `${d.file}:${d.line}:${d.column}`)
      }
    }
    return args
  }

  /**
   * Vitest selection flags: positional file filters, `--project` when every
   * requested test shares one project, and `-t` with the full title path for a
   * single test (Vitest matches `-t` against the full test name as substring).
   * No `--reporter` injection (the project's Vitest config carries the
   * reporter), no `--test-list` temp file, no Playwright version probe.
   */
  private buildVitestArgs(ctx: RunContext, filters: RunFilters, tests: RunTestDescriptor[] | undefined): string[] {
    const args = ['run', '--config', ctx.configFile]
    if (filters.update === true) args.push('--update')
    if (tests !== undefined && tests.length > 0) {
      const project = sharedProject(tests)
      if (project !== undefined) args.push(`--project=${project}`)
      for (const file of new Set(tests.map((t) => t.file))) args.push(file)
      if (tests.length === 1) {
        const only = tests[0]!
        args.push('-t', only.titlePath.join(' '))
      }
    }
    return args
  }

  /**
   * Resolves the launcher for a run and enforces per-runner docker scoping (D5):
   * docker runs are a Playwright-only concept — containerizing a Vitest run would
   * need a vitest + browser-provider image. Explicit docker mode refuses instead
   * of silently changing the rendering environment; auto mode falls back to a
   * local launch with a warning.
   */
  private resolveRunLauncher(
    ctx: RunContext,
  ): { launcher: RunLauncher } | { refusal: 'docker-unsupported-for-runner' } {
    const isVitest = ctx.runner === 'vitest'
    const runMode = this.deps.getRunMode?.() ?? 'local'
    if (isVitest && runMode === 'docker') return { refusal: 'docker-unsupported-for-runner' }
    if (isVitest && runMode === 'auto') {
      const warn =
        this.deps.warn ??
        ((message: string): void => {
          console.warn(message)
        })
      warn('[RunController] Docker skipped: Vitest runs are not containerized; launching locally.')
    }
    return { launcher: isVitest ? (this.deps.localLauncher ?? this.deps.launcher) : this.deps.launcher }
  }

  start(filters: RunFilters): StartResult {
    const ctx = this.deps.getRunContext()
    if (ctx === null) return { ok: false, reason: 'no-config' }
    if (this.child !== null) return { ok: false, reason: 'already-running' }
    if (filters.tests !== undefined && filters.tests.length === 0) return { ok: false, reason: 'no-tests' }

    const resolved = this.resolveRunLauncher(ctx)
    if ('refusal' in resolved) return { ok: false, reason: resolved.refusal }
    const launcher = resolved.launcher
    if (launcher.available === false) return { ok: false, reason: 'docker-unavailable' }

    const tests = rewriteContainerTestDescriptors(filters.tests, this.deps.containerPathMapping)
    const args =
      ctx.runner === 'vitest'
        ? this.buildVitestArgs(ctx, filters, tests)
        : this.buildPlaywrightArgs(ctx, filters, tests)

    const spec = launcher.launch({ ctx, playwrightArgs: args })
    let child: ChildProcessLike
    try {
      child = this.deps.spawn(spec.cmd, spec.args, { cwd: ctx.cwd, env: spec.env, stdio: 'inherit' })
    } catch (err) {
      this.cleanupTempFile()
      throw err
    }
    this.child = child
    this.childLauncher = launcher
    child.on('exit', (code) => {
      this.handleChildExit(code)
    })
    child.on('error', () => {
      this.handleChildExit(null)
    })
    this.deps.onRunStart?.()
    this.deps.setReportRunning(true)
    this.deps.setRunFiltered?.(filters.tests !== undefined)
    this.deps.broadcast({ type: 'run-status', data: { running: true, mode: launcher.mode } })
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
      }
    }, STOP_GRACE_MS)
    return { ok: true }
  }

  async prepareRun(): Promise<{ ok: true } | { ok: false; reason: 'docker-unavailable' }> {
    const ctx = this.deps.getRunContext()
    // Vitest runs never containerize; skip the docker probe/pull entirely.
    if (ctx !== null && ctx.runner === 'vitest') return { ok: true }
    const launcher = this.deps.launcher
    if (launcher.prepare === undefined) return { ok: true }
    if (ctx === null) return { ok: true }
    try {
      await launcher.prepare({
        ctx,
        onProgress: (phase) => {
          this.deps.broadcast({ type: 'run-status', data: { running: true, mode: launcher.mode, phase } })
        },
      })
      return { ok: true }
    } catch (error) {
      this.deps.broadcast({ type: 'run-status', data: { running: false, mode: launcher.mode } })
      const message = error instanceof Error ? error.message : String(error)
      console.warn(`[RunController] run preparation failed: ${message}`)
      return { ok: false, reason: 'docker-unavailable' }
    }
  }

  dispose(): void {
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
    this.childLauncher = null
    this.cleanupTempFile()
    if (code !== null && code !== 0) console.warn(`[RunController] test run exited with code ${code}`)
    this.deps.setReportRunning(false)
    this.deps.broadcast({ type: 'run-status', data: { running: false, mode: launcher.mode } })
    void this.deps.saveReport?.()
  }
}
