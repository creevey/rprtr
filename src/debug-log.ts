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

/** Fixed, documented allowlist of environment names whose values may be recorded. */
const ENV_VALUE_ALLOWLIST = new Set(['CI', 'DEBUG', 'NODE_ENV', 'NODE_OPTIONS'])

/** Prefix covering rprtr's own controls, whose values are safe to record. */
const ENV_VALUE_PREFIX = 'CRVY_RPRTR_'

/** Credential-shaped name fragments whose values must never be recorded. */
const CREDENTIAL_NAME_PATTERN = /(?:TOKEN|SECRET|KEY|PASSWORD|AUTH)/i

const isValueAllowlisted = (name: string): boolean => {
  const upper = name.toUpperCase()
  return upper.startsWith(ENV_VALUE_PREFIX) || ENV_VALUE_ALLOWLIST.has(upper)
}

/** Masks URL userinfo and credential-shaped query parameter values. */
function maskUrlSecrets(value: string): string {
  return value
    .replace(/(\/\/)[^/\s@]+@/g, '$1***@')
    .replace(/([?&][^=&#\s]*(?:TOKEN|SECRET|KEY|PASSWORD|AUTH)[^=&#\s]*=)[^&#\s]*/gi, '$1***')
}

/** One environment variable as it appears in a record: the name, and a value only when allowed. */
export interface RedactedEnvEntry {
  name: string
  value?: string
}

/**
 * Applies the redaction contract per environment variable: every name is
 * recorded, values only for the fixed allowlist, never for credential-shaped
 * names, and recorded values get URL userinfo and token-shaped query
 * parameters masked.
 */
export function redactEnvironment(env: Record<string, string | undefined>): RedactedEnvEntry[] {
  const entries: RedactedEnvEntry[] = []
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue
    if (CREDENTIAL_NAME_PATTERN.test(name) || !isValueAllowlisted(name)) {
      entries.push({ name })
      continue
    }
    entries.push({ name, value: maskUrlSecrets(value) })
  }
  return entries
}

/** Renders the launch-environment record form: `NAME=value` for allowed values, bare names otherwise. */
export function formatEnvironment(env: Record<string, string | undefined>): string {
  return redactEnvironment(env)
    .map((entry) => (entry.value === undefined ? entry.name : `${entry.name}=${entry.value}`))
    .join(' ')
}

/** Scalar field values a record can carry. */
export type DebugValue = string | number | boolean

/**
 * Caps a captured excerpt (listing stderr) at the last line boundary within
 * `limit` characters, keeping the tail where failures state their cause.
 */
export function boundExcerpt(text: string, limit = 2048): string {
  if (text.length <= limit) return text
  const tail = text.slice(text.length - limit)
  const firstNewline = tail.indexOf('\n')
  return firstNewline === -1 ? tail : tail.slice(firstNewline + 1)
}

const needsQuoting = (value: string): boolean => value === '' || /\s/.test(value)

/** Shared `key=value` record shape: `[prefix] key=value key2=value2`, quoting values with whitespace. */
export function formatRecord(prefix: string, fields: Record<string, DebugValue | undefined>): string {
  const pairs: string[] = []
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue
    const text = String(value)
    pairs.push(`${key}=${needsQuoting(text) ? JSON.stringify(text) : text}`)
  }
  return pairs.length === 0 ? `[${prefix}]` : `[${prefix}] ${pairs.join(' ')}`
}
