import { spawn } from 'child_process'
import { join, relative } from 'path'

import { z } from 'zod'

import { safeParse } from '../schemas.ts'
import type { ClientWebSocketMessage, TestData } from '../types.ts'
import { browserLabelFromProjectName } from '../vitest-helpers.ts'
import { fileExists } from './file-utils.ts'
import { resolveSeedConfigFile } from './playwright-config.ts'
import type { RunContext } from './run-controller.ts'
import { resolveLocalCommand } from './run-launcher.ts'

export interface VitestListEntry {
  name: string
  file: string
  projectName?: string
  location?: {
    line: number
    column?: number
  }
}

export interface ListProcess {
  stdout: {
    on(event: 'data', cb: (chunk: string | Buffer) => void): void
  }
  on(event: 'close', cb: (code: number | null) => void): void
  on(event: 'error', cb: (err: Error) => void): void
  kill(signal: 'SIGKILL' | 'SIGTERM'): void
}

export type ListSpawn = (cmd: string, args: string[], opts: Record<string, unknown>) => ListProcess

const VitestListEntrySchema = z.object({
  name: z.string(),
  file: z.string(),
  projectName: z.string().optional(),
  location: z
    .object({
      line: z.number(),
      column: z.number().optional(),
    })
    .optional(),
})

export function parseVitestListStdout(stdout: string): VitestListEntry[] {
  let raw: unknown
  try {
    raw = JSON.parse(stdout)
  } catch {
    return []
  }
  if (!Array.isArray(raw)) return []
  return raw
    .map((item: unknown) => safeParse(VitestListEntrySchema, item))
    .filter((entry): entry is VitestListEntry => entry !== null)
}

function createRealListSpawn(): ListSpawn {
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

const DEFAULT_VITEST_LIST_TIMEOUT_MS = 30_000

export interface RunVitestListOptions {
  configFile: string
  cwd: string
  /** Kill the listing after this long; a hung `vitest list` yields an empty result. */
  timeoutMs?: number
  spawn?: ListSpawn
}

/**
 * Enumerates a Vitest project's tests via `CI=true vitest list --json` — collection
 * only, no browser launch. The command resolves through the same package-manager
 * resolution UI-launched runs use. Stdin is closed (`ignore`) and `CI` is forced so
 * Vitest cannot fall into interactive mode and hang the server. Any failure — spawn
 * error, malformed output, timeout — yields an empty list; callers decide how to log.
 */
export function runVitestList(options: RunVitestListOptions): Promise<VitestListEntry[]> {
  const { configFile, cwd, timeoutMs = DEFAULT_VITEST_LIST_TIMEOUT_MS } = options
  const spawnFn = options.spawn ?? createRealListSpawn()
  const { cmd, args } = resolveLocalCommand('vitest', ['list', '--json', '--config', configFile])

  return new Promise<VitestListEntry[]>((resolve) => {
    let stdout = ''
    let settled = false
    let killTimer: ReturnType<typeof setTimeout> | undefined
    const finish = (entries: VitestListEntry[]): void => {
      if (settled) return
      settled = true
      if (killTimer !== undefined) clearTimeout(killTimer)
      resolve(entries)
    }

    const child = spawnFn(cmd, args, {
      cwd,
      env: { ...process.env, CI: 'true' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.on('data', (chunk: string | Buffer) => {
      stdout += typeof chunk === 'string' ? chunk : chunk.toString()
    })
    child.on('error', () => {
      finish([])
    })
    child.on('close', () => {
      finish(parseVitestListStdout(stdout))
    })
    killTimer = setTimeout(() => {
      child.kill('SIGKILL')
      finish([])
    }, timeoutMs)
  })
}

/** Prefix marking test ids synthesized from discovery rather than a real run. */
export const DISCOVERED_ID_PREFIX = 'discovered:'

// Filenames Vitest accepts as a config, checked in priority order — mirrors the
// Playwright config discovery that seeds Playwright run contexts.
const VITEST_CONFIG_FILES = [
  'vitest.config.ts',
  'vitest.config.mts',
  'vitest.config.cts',
  'vitest.config.js',
  'vitest.config.mjs',
  'vitest.config.cjs',
]

export async function resolveVitestConfig(cwd: string): Promise<string | null> {
  const matches = await Promise.all(
    VITEST_CONFIG_FILES.map(async (file) => {
      const candidate = join(cwd, file)
      return (await fileExists(candidate)) ? candidate : null
    }),
  )
  // find() preserves VITEST_CONFIG_FILES priority order (first existing file wins).
  return matches.find((path): path is string => path !== null) ?? null
}

/**
 * Startup run-context seeding. A Playwright config — discovered or passed via the
 * CLI `--config` flag — keeps precedence exactly as before. Otherwise a discovered
 * `vitest.config.*` seeds a Vitest run context so the run controls are enabled
 * before any reporter registers.
 */
export async function resolveSeedRunContext(
  playwrightConfig: string | undefined,
  cwd: string,
): Promise<RunContext | null> {
  const configFile = await resolveSeedConfigFile(playwrightConfig, cwd)
  if (configFile !== null) {
    return { configFile, cwd }
  }
  const vitestConfig = await resolveVitestConfig(cwd)
  if (vitestConfig !== null) {
    return { configFile: vitestConfig, cwd, rootDir: cwd, runner: 'vitest' }
  }
  return null
}

/**
 * Stable identity of a discovered test: (file, full title path). Survives across
 * runs, unlike Vitest's runtime task ids, so discovered entries can be matched
 * against tests a loaded report already knows.
 */
export function discoveredTestIdentity(file: string, fullName: string): string {
  return `${file}\u0000${fullName}`
}

function toTitlePath(relativeFile: string, fullName: string): string[] {
  const fileTokens = relativeFile.split(/[/\\]/)
  const nameParts = fullName.split(' > ')
  return [...fileTokens, ...nameParts.slice(0, -1)]
}

/**
 * Maps flat `vitest list` entries onto the tree the streamed results produce:
 * suites from the Vitest-root-relative file path (plus the entry's own suite
 * nesting), `pending` status, browser label from the project name, and a
 * `discovered:`-prefixed id so provenance stays explicit. Multi-project configs
 * emit one entry per project; the project-derived browser label keeps them
 * distinct, mirroring how streamed results separate browsers.
 */
export function synthesizeDiscoveredTests(entries: VitestListEntry[], root: string): TestData[] {
  const byId = new Map<string, TestData>()
  for (const entry of entries) {
    const relativeFile = relative(root, entry.file)
    const nameParts = entry.name.split(' > ')
    const browser = browserLabelFromProjectName(entry.projectName)
    const id = `${DISCOVERED_ID_PREFIX}${relativeFile}:${browser}:${entry.name}`
    if (byId.has(id)) continue

    const location = entry.location
    byId.set(id, {
      id,
      titlePath: toTitlePath(relativeFile, entry.name),
      browser,
      projectName: entry.projectName,
      title: nameParts[nameParts.length - 1] ?? entry.name,
      ...(location === undefined
        ? {}
        : {
            location: {
              file: entry.file,
              line: location.line,
              ...(location.column === undefined ? {} : { column: location.column }),
            },
          }),
      provider: 'vitest',
      status: 'pending',
    })
  }
  return [...byId.values()]
}

/**
 * Identity of a test a real run streamed: (location file, full title path) — the
 * same tuple a discovered entry is identified by, so the two can be matched.
 */
function reportTestIdentity(test: TestData): string | null {
  const file = test.location?.file
  if (file === undefined) return null
  return discoveredTestIdentity(file, [...test.titlePath, test.title].join(' > '))
}

/**
 * Merges discovered entries into the report state, filling only identities the
 * report does not already know — loaded results are never downgraded to pending.
 * Returns true when anything was added.
 */
export function mergeDiscoveredTests(
  reportData: { tests: Record<string, TestData> },
  entries: VitestListEntry[],
  root: string,
): boolean {
  const knownIdentities = new Set<string>()
  for (const test of Object.values(reportData.tests)) {
    const identity = reportTestIdentity(test)
    if (identity !== null) knownIdentities.add(identity)
  }

  let changed = false
  for (const entry of entries) {
    if (knownIdentities.has(discoveredTestIdentity(entry.file, entry.name))) continue
    const [test] = synthesizeDiscoveredTests([entry], root)
    if (test === undefined || reportData.tests[test.id] !== undefined) continue
    reportData.tests[test.id] = test
    changed = true
  }
  return changed
}

export interface SeedDiscoveredTestsDeps {
  runContext: RunContext | undefined
  reportData: { isRunning: boolean; tests: Record<string, TestData>; isUpdateMode: boolean }
  broadcast: (message: ClientWebSocketMessage) => void
}

/**
 * One-shot startup listing for a Vitest run context: enumerates the project's
 * tests and merges them into the report tree as `pending`. Fire-and-forget from
 * the caller's perspective — the server is interactive before this lands, and a
 * failed listing only logs, leaving the discovered run controls enabled.
 */
export async function seedDiscoveredTests(deps: SeedDiscoveredTestsDeps): Promise<void> {
  const runContext = deps.runContext
  if (runContext === undefined || runContext.runner !== 'vitest') return

  const entries = await runVitestList({ configFile: runContext.configFile, cwd: runContext.cwd })
  // A run that started while the listing was in flight replaces the whole tree;
  // discovered state must never be injected into an active run.
  if (deps.reportData.isRunning) return
  if (entries.length === 0) {
    console.error(
      '[VitestDiscovery] `vitest list` returned no tests; run controls stay enabled and the sidebar keeps its loaded state',
    )
    return
  }
  const changed = mergeDiscoveredTests(deps.reportData, entries, runContext.cwd)
  if (!changed) return
  deps.broadcast({
    type: 'sync',
    data: { tests: deps.reportData.tests, isUpdateMode: deps.reportData.isUpdateMode },
  })
}
