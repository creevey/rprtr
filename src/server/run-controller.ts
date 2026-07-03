import { spawn } from 'child_process'
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveCommand } from 'package-manager-detector/commands'
import { getUserAgent } from 'package-manager-detector/detect'

import type { RunTestDescriptor } from '../schemas.ts'
import type { ClientWebSocketMessage } from '../types.ts'

export interface RunContext {
  configFile: string
  cwd: string
}

export interface RunFilters {
  tests?: RunTestDescriptor[]
}

export type StartResult = { ok: true } | { ok: false; reason: 'no-config' | 'already-running' | 'no-tests' }

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
  /** Flushes pending report writes on child exit so an interrupted run still persists. */
  saveReport?: () => Promise<void>
  spawn: SpawnLike
  timers: {
    setTimeout: (fn: () => void, ms?: number) => unknown
    clearTimeout: (handle: unknown) => void
  }
  resolveReporter?: (cwd: string) => string | null
  /** Resolves the package-manager-aware command used to launch `playwright`. Falls back to `npx`. */
  resolveLaunch?: (cwd: string, playwrightArgs: string[]) => { cmd: string; args: string[] }
  /** Injectable seams for the version-gated `--test-list` path (Playwright >= 1.56). */
  getPlaywrightVersion?: (cwd: string) => string | null
  writeTempFile?: (content: string) => string
  deleteTempFile?: (path: string) => void
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

function descriptorLocation(d: RunTestDescriptor): string {
  return d.column === undefined ? `${d.file}:${d.line}` : `${d.file}:${d.line}:${d.column}`
}

function sharedProject(tests: RunTestDescriptor[]): string | undefined {
  const names = new Set(tests.map((t) => t.projectName ?? ''))
  if (names.size === 1) {
    const name = [...names][0]
    return name === '' ? undefined : name
  }
  return undefined
}

/** `MAJOR.MINOR` threshold check using only leading digits; ignores pre-release suffixes. False for unparseable input. */
export function gteMinor(version: string, major: number, minor: number): boolean {
  const match = /^(\d+)\.(\d+)/.exec(version.trim())
  if (match === null) return false
  const maj = parseInt(match[1]!, 10)
  const min = parseInt(match[2]!, 10)
  if (maj !== major) return maj > major
  return min >= minor
}

/** Reads the installed `@playwright/test` version from cwd; null when unresolvable (→ positional fallback). */
function resolvePlaywrightVersion(cwd: string): string | null {
  try {
    const req = createRequire(join(cwd, 'package.json'))
    const pkgPath = req.resolve('@playwright/test/package.json')
    const pkg: unknown = JSON.parse(readFileSync(pkgPath, 'utf8'))
    return typeof pkg === 'object' && pkg !== null && 'version' in pkg && typeof pkg.version === 'string'
      ? pkg.version
      : null
  } catch {
    return null
  }
}

/** Builds `--test-list` lines mirroring `playwright test --list`: `[project] › file:line:column › title path`. */
export function buildTestListEntries(tests: RunTestDescriptor[]): string[] {
  return tests.map((d) => {
    const loc = descriptorLocation(d)
    const title = d.titlePath.join(' \u203a ')
    const prefix = d.projectName !== undefined && d.projectName !== '' ? `[${d.projectName}] \u203a ` : ''
    return `${prefix}${loc} \u203a ${title}`
  })
}

function defaultWriteTempFile(content: string): string {
  const path = join(tmpdir(), `crvy-rprtr-test-list-${process.pid}-${Date.now()}.txt`)
  writeFileSync(path, content, 'utf8')
  return path
}

function defaultDeleteTempFile(path: string): void {
  try {
    unlinkSync(path)
  } catch {
    // Ignore — the file may already be removed (e.g. double exit/error).
  }
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

  start(filters: RunFilters): StartResult {
    const ctx = this.deps.getRunContext()
    if (ctx === null) return { ok: false, reason: 'no-config' }
    if (this.child !== null) return { ok: false, reason: 'already-running' }
    if (filters.tests !== undefined && filters.tests.length === 0) {
      return { ok: false, reason: 'no-tests' }
    }

    const resolveReporter = this.deps.resolveReporter ?? resolveReporterDefault
    const reporterModule = resolveReporter(ctx.cwd)
    const tests = filters.tests
    const useTestList = tests !== undefined && tests.length > 1 && this.supportsTestList(ctx.cwd)

    const args = ['test', '--config', ctx.configFile]
    if (reporterModule !== null) args.push('--reporter', reporterModule)

    if (useTestList && tests !== undefined) {
      const content = buildTestListEntries(tests).join('\n')
      const writeTemp = this.deps.writeTempFile ?? defaultWriteTempFile
      this.testListPath = writeTemp(content)
      args.push('--test-list', this.testListPath)
    } else if (tests !== undefined && tests.length > 0) {
      const project = sharedProject(tests)
      if (project !== undefined) args.push('--project', project)
      for (const d of tests) args.push(descriptorLocation(d))
    }

    const resolveLaunch = this.deps.resolveLaunch ?? resolvePlaywrightLaunch
    const { cmd, args: launchArgs } = resolveLaunch(ctx.cwd, args)
    let child: ChildProcessLike
    try {
      child = this.deps.spawn(cmd, launchArgs, { cwd: ctx.cwd, env: buildSpawnEnv(this.deps.port), stdio: 'inherit' })
    } catch (err) {
      this.cleanupTempFile()
      throw err
    }
    this.child = child
    child.on('exit', (code) => {
      this.handleChildExit(code)
    })
    child.on('error', () => {
      this.handleChildExit(null)
    })
    this.deps.setReportRunning(true)
    this.deps.setRunFiltered?.(filters.tests !== undefined)
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
    this.cleanupTempFile()
  }

  private handleChildExit(code: number | null): void {
    if (this.child === null) return
    if (this.sigkillTimer !== null) {
      this.deps.timers.clearTimeout(this.sigkillTimer)
      this.sigkillTimer = null
    }
    this.child = null
    this.cleanupTempFile()
    if (code !== null && code !== 0) {
      console.warn(`[RunController] playwright test exited with code ${code}`)
    }
    this.deps.setReportRunning(false)
    this.deps.broadcast({ type: 'run-status', data: { running: false } })
    void this.deps.saveReport?.()
  }
}

export function createRealSpawn(): SpawnLike {
  return (cmd, args, opts): ChildProcessLike => {
    const cp = spawn(cmd, args, opts)
    return {
      on: (event, cb) => cp.on(event, cb),
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
