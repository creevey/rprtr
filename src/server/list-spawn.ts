import { spawn } from 'child_process'

/**
 * Minimal child-process surface the test listers use. Both runners spawn a
 * collection-only listing and read its stdout, so the seam stays shared and
 * unit tests can inject a fake without launching a real runner.
 */
export interface ListProcess {
  stdout: {
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

export function createRealListSpawn(): ListSpawn {
  return (cmd, args, opts): ListProcess => {
    const cp = spawn(cmd, args, opts)
    return {
      stdout: {
        on: (event, cb) => cp.stdout?.on(event, cb),
      },
      on: (event, cb) => cp.on(event, cb),
      kill: (signal) => {
        cp.kill(signal)
      },
    }
  }
}
