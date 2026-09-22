import { resolveProjectPins, type PlaywrightProjectLike, type ResolvedProjectPin } from './browser-pins.ts'
import { DOCKER_HOST_GATEWAY, DOCKER_HOST_GATEWAY_ENV, DOCKER_MODE_ENV } from './docker-contract.ts'
import {
  configDumpPath,
  DOCKER_CONFIG_DUMP_ENV,
  ensureConfigDumpReporter,
  readAndDeleteConfigDump,
  type DockerConfigSummary,
} from './server/config-dump.ts'
import { createRealListSpawn, type ListFailure, type ListSpawn } from './server/list-spawn.ts'
import { resolveLocalCommand } from './server/run-launcher.ts'

const LIST_TIMEOUT_MS = 60_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Reads pins out of Playwright's own JSON list report: `config.metadata` is the
 * config-root fallback, each `config.projects[]` carries the project's own
 * metadata. Returns [] for reports without a config section.
 */
export function parseProjectPinsFromListReport(report: unknown): ResolvedProjectPin[] {
  if (!isRecord(report)) return []
  const config = report.config
  if (!isRecord(config)) return []
  const projects = Array.isArray(config.projects) ? config.projects : []
  return resolveProjectPins({
    configMetadata: config.metadata,
    projects: projects.filter(isRecord).map((project) => project as PlaywrightProjectLike),
  })
}

export interface ReadPlaywrightListOptions {
  /** Appended as `--config <path>` so a server started with an explicit config lists that project. */
  configFile?: string
  /** Kill the listing after this long; a hung listing resolves null. */
  timeoutMs?: number
  spawn?: ListSpawn
  /** Extra reporter module appended to the JSON reporter (`--reporter=json,<path>`). */
  extraReporter?: string
  /** Extra environment for the listing process, merged over `process.env`. */
  env?: Record<string, string | undefined>
}

export interface PlaywrightListOutcome {
  /** Parsed JSON report; null when nothing parseable arrived (exit, spawn error, timeout). */
  report: Record<string, unknown> | null
  /** Why the listing failed; null when it produced a report. */
  failure: ListFailure | null
}

function parseListReport(stdout: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(stdout)
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * Spawns the project's own `playwright test --list --reporter=json` — optionally
 * pinned to a config path — and reports both the parsed JSON report and why the
 * listing failed. `readPlaywrightListReport` keeps the report-or-null view for
 * pin and preflight callers; discovery uses the outcome to tell a failed listing
 * apart from a genuinely empty project.
 */
export function readPlaywrightListOutcome(
  cwd: string,
  options: ReadPlaywrightListOptions = {},
): Promise<PlaywrightListOutcome> {
  const reporter = options.extraReporter === undefined ? 'json' : `json,${options.extraReporter}`
  const listArgs = ['test', '--list', `--reporter=${reporter}`]
  if (options.configFile !== undefined) listArgs.push('--config', options.configFile)
  const { cmd, args } = resolveLocalCommand('playwright', listArgs)
  const spawnFn = options.spawn ?? createRealListSpawn()
  const timeoutMs = options.timeoutMs ?? LIST_TIMEOUT_MS
  const spawnOpts: Record<string, unknown> = { cwd, stdio: ['ignore', 'pipe', 'pipe'] }
  if (options.env !== undefined) spawnOpts.env = { ...process.env, ...options.env }

  return new Promise((resolve) => {
    let stdout = ''
    let settled = false
    const child = spawnFn(cmd, args, spawnOpts)
    const finish = (value: PlaywrightListOutcome): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish({ report: null, failure: 'timeout' })
    }, timeoutMs)
    child.stdout.on('data', (chunk: string | Buffer) => {
      stdout += typeof chunk === 'string' ? chunk : chunk.toString()
    })
    child.on('error', () => {
      finish({ report: null, failure: 'spawn' })
    })
    child.on('close', (code) => {
      const report = parseListReport(stdout)
      if (code !== 0) {
        finish({ report, failure: 'exit' })
        return
      }
      finish(report === null ? { report: null, failure: 'parse' } : { report, failure: null })
    })
  })
}

/**
 * The parsed report, falling back to null when the command fails without
 * parseable output (no Playwright, broken config, timeout). A parseable report
 * is returned even on a non-zero exit so pin/preflight callers keep their
 * "listing unknown only when nothing parsed" behavior.
 */
export async function readPlaywrightListReport(
  cwd: string,
  options: ReadPlaywrightListOptions = {},
): Promise<Record<string, unknown> | null> {
  return (await readPlaywrightListOutcome(cwd, options)).report
}

/** Reads the declared browser pins from a Playwright config; [] when unresolvable. */
export async function readProjectPinsFromConfig(cwd: string): Promise<ResolvedProjectPin[]> {
  const report = await readPlaywrightListReport(cwd)
  return report === null ? [] : parseProjectPinsFromListReport(report)
}

export interface PlaywrightListWithConfigResult {
  report: Record<string, unknown> | null
  /** Resolved config summary; null when the listing or the dump was unavailable. */
  config: DockerConfigSummary | null
}

/**
 * One dump-aware listing spawn for the docker preflight. The listing runs with the
 * docker gateway contract exported, so the config resolves as the container will
 * see it (`CRVY_RPRTR_DOCKER` / `CRVY_RPRTR_HOST_GATEWAY` recipes included), and
 * returns the JSON list report plus the resolved config summary, which is only
 * reachable from inside a `v2` reporter (array-form `webServer`, `use.baseURL`).
 * A missing or malformed dump degrades to a null summary and never fails the listing.
 */
export async function readPlaywrightListWithConfig(
  cwd: string,
  options: Omit<ReadPlaywrightListOptions, 'extraReporter' | 'env'> = {},
): Promise<PlaywrightListWithConfigResult> {
  const reporter = ensureConfigDumpReporter()
  const dumpPath = configDumpPath()
  const report = await readPlaywrightListReport(cwd, {
    ...options,
    extraReporter: reporter,
    env: {
      [DOCKER_MODE_ENV]: '1',
      [DOCKER_HOST_GATEWAY_ENV]: DOCKER_HOST_GATEWAY,
      [DOCKER_CONFIG_DUMP_ENV]: dumpPath,
    },
  })
  return { report, config: readAndDeleteConfigDump(dumpPath) }
}
