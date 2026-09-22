import { relative } from 'path'

import { z } from 'zod'

import { safeParse } from '../schemas.ts'
import type { TestData } from '../types.ts'
import { browserLabelFromProjectName, relativeFileTokens } from '../vitest-helpers.ts'
import { DISCOVERED_ID_PREFIX } from './discovered-tests.ts'
import { createRealListSpawn, type ListSpawn } from './list-spawn.ts'
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
 * browsers. The location always carries the absolute test file — line falls
 * back the same way the Vitest reporter's streamed events do — so a discovered
 * entry stays identifiable as (file, full title path).
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
      location: {
        file: entry.file,
        line: location?.line ?? 1,
        ...(location?.column === undefined ? {} : { column: location.column }),
      },
      provider: 'vitest',
      status: 'pending',
    })
  }
  return [...byId.values()]
}
