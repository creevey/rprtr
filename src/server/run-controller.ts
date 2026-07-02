import { spawn, type ChildProcess } from 'child_process'
import { createRequire } from 'node:module'
import { join } from 'node:path'

import { resolveCommand } from 'package-manager-detector/commands'
import { getUserAgent } from 'package-manager-detector/detect'

import type { ClientWebSocketMessage } from '../types.ts'

export interface RunContext {
  configFile: string
  cwd: string
}

export interface RunFilters {
  files?: string[]
  project?: string
}

export type StartResult = { ok: true } | { ok: false; reason: 'no-config' | 'already-running' }

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
  spawn: SpawnLike
  timers: {
    setTimeout: (fn: () => void, ms?: number) => unknown
    clearTimeout: (handle: unknown) => void
  }
  resolveReporter?: (cwd: string) => string | null
  /** Resolves the package-manager-aware command used to launch `playwright`. Falls back to `npx`. */
  resolveLaunch?: (cwd: string, playwrightArgs: string[]) => { cmd: string; args: string[] }
}

const STOP_GRACE_MS = 5000

const KNOWN_SIGNALS: Record<string, NodeJS.Signals> = {
  SIGTERM: 'SIGTERM',
  SIGKILL: 'SIGKILL',
}

/**
 * Resolves the `playwright` launch command for the project's package manager.
 * `cwd` is reserved for future cwd-based detection (`package-manager-detector`'s
 * `detect` is async in v1.x and cannot run in the synchronous `start()` path),
 * so today detection uses the synchronous `getUserAgent()`, matching Creevey's
 * spawn pattern. Falls back to `npx` when no agent is detectable.
 */
export function resolvePlaywrightLaunch(cwd: string, playwrightArgs: string[]): { cmd: string; args: string[] } {
  const agent = getUserAgent()
  const resolved = agent === null ? null : resolveCommand(agent, 'execute-local', ['playwright', ...playwrightArgs])
  if (resolved !== null) return { cmd: resolved.command, args: resolved.args }
  return { cmd: 'npx', args: ['playwright', ...playwrightArgs] }
}

function toArgs(filters: RunFilters, configFile: string, reporterModule: string | null): string[] {
  const args = ['test', '--config', configFile]
  if (reporterModule !== null) args.push('--reporter', reporterModule)
  if (filters.project !== undefined) args.push('--project', filters.project)
  if (filters.files !== undefined) args.push(...filters.files)
  return args
}

export function resolveReporterDefault(cwd: string): string | null {
  try {
    return createRequire(join(cwd, 'package.json')).resolve('@crvy/rprtr')
  } catch {
    // Not installed in the project; fall through to the server's own package.
  }
  try {
    return createRequire(import.meta.url).resolve('@crvy/rprtr')
  } catch {
    return null
  }
}

function buildSpawnEnv(port: number): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (key === 'CI') continue
    env[key] = value
  }
  env.CRVY_RPRTR_SERVER_URL = `ws://localhost:${port}`
  env.PLAYWRIGHT_HTML_OPEN = 'never'
  return env
}

export class RunController {
  private child: ChildProcessLike | null = null
  private sigkillTimer: unknown = null

  constructor(private readonly deps: RunControllerDeps) {}

  get isRunning(): boolean {
    return this.child !== null
  }

  start(filters: RunFilters): StartResult {
    const ctx = this.deps.getRunContext()
    if (ctx === null) return { ok: false, reason: 'no-config' }
    if (this.child !== null) return { ok: false, reason: 'already-running' }

    const resolveReporter = this.deps.resolveReporter ?? resolveReporterDefault
    const reporterModule = resolveReporter(ctx.cwd)
    const resolveLaunch = this.deps.resolveLaunch ?? resolvePlaywrightLaunch
    const playwrightArgs = toArgs(filters, ctx.configFile, reporterModule)
    const { cmd, args } = resolveLaunch(ctx.cwd, playwrightArgs)
    const child = this.deps.spawn(cmd, args, {
      cwd: ctx.cwd,
      env: buildSpawnEnv(this.deps.port),
      stdio: 'inherit',
    })
    this.child = child
    child.on('exit', (code) => {
      this.handleChildExit(code)
    })
    child.on('error', () => {
      this.handleChildExit(null)
    })
    this.deps.setReportRunning(true)
    this.deps.setRunFiltered?.(filters.files !== undefined || filters.project !== undefined)
    this.deps.broadcast({ type: 'run-status', data: { running: true } })
    return { ok: true }
  }

  stop(): StopResult {
    if (this.child === null) return { ok: false, reason: 'not-running' }
    if (this.sigkillTimer !== null) this.deps.timers.clearTimeout(this.sigkillTimer)
    this.child.kill('SIGTERM')
    this.sigkillTimer = this.deps.timers.setTimeout(() => {
      if (this.child !== null) this.child.kill('SIGKILL')
    }, STOP_GRACE_MS)
    return { ok: true }
  }

  dispose(): void {
    if (this.child === null) return
    if (this.sigkillTimer !== null) this.deps.timers.clearTimeout(this.sigkillTimer)
    this.sigkillTimer = null
    this.child.kill('SIGKILL')
  }

  private handleChildExit(code: number | null): void {
    if (this.child === null) return
    if (this.sigkillTimer !== null) {
      this.deps.timers.clearTimeout(this.sigkillTimer)
      this.sigkillTimer = null
    }
    this.child = null
    if (code !== null && code !== 0) {
      console.warn(`[RunController] playwright test exited with code ${code}`)
    }
    this.deps.setReportRunning(false)
    this.deps.broadcast({ type: 'run-status', data: { running: false } })
  }
}

export function createRealSpawn(): SpawnLike {
  return (cmd, args, opts): ChildProcessLike => {
    const cp = spawn(cmd, args, opts)
    return {
      on: (event, cb) => {
        cp.on(event, cb)
      },
      kill: (signal) => {
        const sig = KNOWN_SIGNALS[signal]
        if (sig !== undefined) cp.kill(sig)
      },
    }
  }
}

export function createRealTimers(): RunControllerDeps['timers'] {
  const pending: NodeJS.Timeout[] = []
  return {
    setTimeout: (fn, ms?): unknown => {
      const id = setTimeout(fn, ms)
      pending.push(id)
      return id
    },
    clearTimeout: (): void => {
      for (const h of pending.splice(0)) clearTimeout(h)
    },
  }
}

export type { ChildProcess }
