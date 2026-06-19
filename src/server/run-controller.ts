import { spawn, type ChildProcess } from 'child_process'

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
  spawn: SpawnLike
  timers: {
    setTimeout: (fn: () => void, ms?: number) => unknown
    clearTimeout: (handle: unknown) => void
  }
}

const STOP_GRACE_MS = 5000

const KNOWN_SIGNALS: Record<string, NodeJS.Signals> = {
  SIGTERM: 'SIGTERM',
  SIGKILL: 'SIGKILL',
}

function resolveBin(_cwd: string): { cmd: string; argsPrefix: string[] } {
  return { cmd: 'npx', argsPrefix: ['playwright'] }
}

function toArgs(filters: RunFilters, configFile: string): string[] {
  const args = ['test', '--config', configFile]
  if (filters.project !== undefined) args.push('--project', filters.project)
  if (filters.files !== undefined) args.push(...filters.files)
  return args
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

    const { cmd, argsPrefix } = resolveBin(ctx.cwd)
    const args = [...argsPrefix, ...toArgs(filters, ctx.configFile)]
    const child = this.deps.spawn(cmd, args, {
      cwd: ctx.cwd,
      env: { ...process.env, CRVY_RPRTR_SERVER_URL: `ws://localhost:${this.deps.port}` },
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
    this.deps.broadcast({ type: 'run-status', data: { running: true } })
    return { ok: true }
  }

  stop(): StopResult {
    if (this.child === null) return { ok: false, reason: 'not-running' }
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
