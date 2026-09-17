import { spawn } from 'child_process'
import { relative } from 'path'

import { z } from 'zod'

import { safeParse } from '../schemas.ts'
import type { TestData } from '../types.ts'
import { browserLabelFromProjectName, relativeFileTokens } from '../vitest-helpers.ts'
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

/**
 * Stable identity of a discovered test: (file, full title path). Survives across
 * runs, unlike Vitest's runtime task ids, so discovered entries can be matched
 * against tests a loaded report already knows.
 */
export function discoveredTestIdentity(file: string, fullName: string): string {
  return `${file}\u0000${fullName}`
}

function toTitlePath(fullName: string): string[] {
  return fullName.split(' > ').slice(0, -1)
}

/**
 * Maps flat `vitest list` entries onto the tree the streamed results produce:
 * `fileTokens` from the Vitest-root-relative file path, describe suites from
 * the entry's full name, `pending` status, browser label from the project
 * name, and a `discovered:`-prefixed id so provenance stays explicit.
 * Multi-project configs emit one entry per project; the project-derived
 * browser label keeps them distinct, mirroring how streamed results separate
 * browsers.
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
      fileTokens: relativeFileTokens(root, entry.file),
      titlePath: toTitlePath(entry.name),
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
