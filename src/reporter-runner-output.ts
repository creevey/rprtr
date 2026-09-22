import type { TestError } from '@playwright/test/reporter'

import { formatErrorReport } from './reporter-utils.ts'

/** Write seams for forwarded runner output; both default to the process streams. */
export interface RunnerOutputSeams {
  /** Where forwarded runner stdout is written. Defaults to `process.stdout`. */
  stdout?: (chunk: string) => void
  /** Where forwarded runner stderr is written. Defaults to `process.stderr`. */
  stderr?: (chunk: string) => void
}

function writeProcessStdout(chunk: string): void {
  process.stdout.write(chunk)
}

function writeProcessStderr(chunk: string): void {
  process.stderr.write(chunk)
}

/**
 * Playwright forwards the runner's fatal error reports and process output to every
 * reporter that implements `onError`/`onStdOut`/`onStdErr` and drops them otherwise.
 * Server-launched runs replace the reporters with crvy-rprtr alone, so printing here
 * is what keeps a failure outside a test body diagnosable from the terminal.
 * Passthrough is independent of CI mode and of live-server connectivity, and never
 * touches report state or artifacts.
 */
export function writeRunnerError(error: TestError, seams: RunnerOutputSeams): void {
  const write = seams.stderr ?? writeProcessStderr
  write(`${formatErrorReport(error)}\n`)
}

export function writeRunnerStdout(chunk: string, seams: RunnerOutputSeams): void {
  const write = seams.stdout ?? writeProcessStdout
  write(chunk)
}

export function writeRunnerStderr(chunk: string, seams: RunnerOutputSeams): void {
  const write = seams.stderr ?? writeProcessStderr
  write(chunk)
}
