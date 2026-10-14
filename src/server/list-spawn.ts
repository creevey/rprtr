import { spawn } from 'child_process'

import { boundExcerpt, formatRecord, type DebugLogger } from '../debug-log.ts'

/**
 * Minimal child-process surface the test listers use. Both runners spawn a
 * collection-only listing and read its stdout, so the seam stays shared and
 * unit tests can inject a fake without launching a real runner.
 */
export interface ListProcess {
  stdout: {
    on(event: 'data', cb: (chunk: string | Buffer) => void): void
  }
  /**
   * Optional stderr handle: capture-only listings accumulate it for the debug
   * record; fakes may omit it.
   */
  stderr?: {
    on(event: 'data', cb: (chunk: string | Buffer) => void): void
  }
  on(event: 'close', cb: (code: number | null) => void): void
  on(event: 'error', cb: (err: Error) => void): void
  kill(signal: 'SIGKILL' | 'SIGTERM'): void
}

export type ListSpawn = (cmd: string, args: string[], opts: Record<string, unknown>) => ListProcess

/** Why a collection-only listing failed instead of producing entries. */
export type ListFailure = 'exit' | 'parse' | 'spawn' | 'timeout'

/**
 * Collection-only listing outcome. `ok: false` must never be folded into an
 * empty project: startup degrades to one log line, and refresh leaves the
 * discovered layer untouched rather than erasing a valid tree.
 */
export type ListResult<T> = { ok: true; entries: T[] } | { ok: false; reason: ListFailure }

export interface ListDiagnosticsInput {
  debug?: DebugLogger
  /** Record prefix naming the lister, e.g. `PlaywrightList`. */
  prefix: string
  cmd: string
  args: readonly string[]
  cwd: string
}

/**
 * Shared capture and failure record for collection-only listings: accumulates
 * stdout/stderr and, when debug is on, records why a listing failed with the
 * exact command and a bounded stderr excerpt. Both listers keep their own
 * control flow on top of this.
 */
export function createListDiagnostics(input: ListDiagnosticsInput): {
  attach(child: ListProcess): void
  stdout(): string
  emitFailure(reason: ListFailure, exitCode?: number | null): void
} {
  let stdout = ''
  let stderr = ''
  const toText = (chunk: string | Buffer): string => (typeof chunk === 'string' ? chunk : chunk.toString())
  return {
    attach: (child): void => {
      child.stdout.on('data', (chunk) => {
        stdout += toText(chunk)
      })
      child.stderr?.on('data', (chunk) => {
        stderr += toText(chunk)
      })
    },
    stdout: (): string => stdout,
    emitFailure: (reason, exitCode): void => {
      if (input.debug?.enabled !== true) return
      input.debug.log(
        formatRecord(input.prefix, {
          event: 'listing-failed',
          command: [input.cmd, ...input.args].join(' '),
          cwd: input.cwd,
          reason,
          exitCode: exitCode ?? undefined,
          stderr: boundExcerpt(stderr.trim()),
        }),
      )
    },
  }
}

export function createRealListSpawn(): ListSpawn {
  return (cmd, args, opts): ListProcess => {
    const cp = spawn(cmd, args, opts)
    return {
      stdout: {
        on: (event, cb) => cp.stdout?.on(event, cb),
      },
      stderr: {
        on: (event, cb) => cp.stderr?.on(event, cb),
      },
      on: (event, cb) => cp.on(event, cb),
      kill: (signal) => {
        cp.kill(signal)
      },
    }
  }
}
