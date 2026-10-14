const isSet = (value: string | undefined): boolean => value !== undefined && value !== ''

/** Environment variable activating debug mode; the server exports it into every spawned process. */
export const DEBUG_ENV = 'CRVY_RPRTR_DEBUG'

/**
 * Reporter-side debug gate: `CRVY_RPRTR_DEBUG`, with `DEBUG` kept as the
 * legacy alias so existing invocations keep working. Server-side activation is
 * resolved separately and never reads `DEBUG`.
 */
const isReporterDebug = (): boolean => isSet(process.env.CRVY_RPRTR_DEBUG) || isSet(process.env.DEBUG)

export const log = (...args: unknown[]): void => {
  if (isReporterDebug()) console.log(...args)
}

export const logError = (...args: unknown[]): void => {
  if (isReporterDebug()) console.error(...args)
}

/**
 * Terminal-only debug channel for the server tier: a pre-bound sink plus the
 * single activation decision. Call sites never read the environment; records
 * compose through `log` and disappear entirely when disabled.
 */
export interface DebugLogger {
  readonly enabled: boolean
  log(line: string): void
}

export interface DebugLoggerOptions {
  enabled: boolean
  sink: (line: string) => void
}

export function createDebugLogger(options: DebugLoggerOptions): DebugLogger {
  return {
    enabled: options.enabled,
    log(line: string): void {
      if (options.enabled) options.sink(line)
    },
  }
}

export interface DebugSettingsInput {
  /** The `--debug` flag / `ServerOptions.debug`. */
  flag?: boolean
  /** Environment to read; defaults to `process.env`. */
  env?: Record<string, string | undefined>
  /** Terminal sink for enabled records; defaults to `console.log`. */
  sink?: (line: string) => void
}

/**
 * Resolves server-side debug activation once at startup: the flag or a
 * non-empty `CRVY_RPRTR_DEBUG`. Playwright's `DEBUG` alone never enables
 * server records or container retention.
 */
export function resolveDebugSettings(input: DebugSettingsInput = {}): DebugLogger {
  const env = input.env ?? process.env
  return createDebugLogger({
    enabled: input.flag === true || isSet(env[DEBUG_ENV]),
    sink:
      input.sink ??
      ((line: string): void => {
        console.log(line)
      }),
  })
}
