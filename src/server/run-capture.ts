import { formatRecord, type DebugLogger } from '../debug-log.ts'
import type { ChildProcessLike } from './run-controller-types.ts'

/** Stream prefixes mirrored child output carries: stdout and stderr. */
const STDOUT_PREFIX = '[run>] '
const STDERR_PREFIX = '[run!] '

interface StreamState {
  bytes: number
  remainder: string
}

export interface RunCapture {
  /** Flushes trailing partial lines and records the byte summary; called once at exit. */
  settle(): void
}

/**
 * Debug-only mirrored capture (D4): pipes the child's stdout/stderr through a
 * line buffer and mirrors complete lines with stream prefixes, so output a
 * swallowed server stdout would hide stays visible. The byte counts land in an
 * exit summary — a child that wrote nothing is recorded as such.
 */
export function attachRunCapture(child: ChildProcessLike, debug: DebugLogger): RunCapture {
  const stdout: StreamState = { bytes: 0, remainder: '' }
  const stderr: StreamState = { bytes: 0, remainder: '' }
  const toText = (chunk: string | Buffer): string => (typeof chunk === 'string' ? chunk : chunk.toString())
  const mirror = (prefix: string, line: string): void => {
    debug.log(`${prefix}${line.replace(/\r$/, '')}`)
  }
  const consume = (state: StreamState, prefix: string, chunk: string | Buffer): void => {
    const text = toText(chunk)
    state.bytes += Buffer.byteLength(text)
    const parts = `${state.remainder}${text}`.split('\n')
    state.remainder = parts.pop() ?? ''
    for (const line of parts) mirror(prefix, line)
  }
  child.stdout?.on('data', (chunk) => {
    consume(stdout, STDOUT_PREFIX, chunk)
  })
  child.stderr?.on('data', (chunk) => {
    consume(stderr, STDERR_PREFIX, chunk)
  })
  return {
    settle(): void {
      if (stdout.remainder !== '') mirror(STDOUT_PREFIX, stdout.remainder)
      if (stderr.remainder !== '') mirror(STDERR_PREFIX, stderr.remainder)
      debug.log(
        formatRecord('RunController', {
          event: 'output-summary',
          stdoutBytes: stdout.bytes,
          stderrBytes: stderr.bytes,
          wroteNothing: stdout.bytes + stderr.bytes === 0 ? true : undefined,
        }),
      )
    },
  }
}
