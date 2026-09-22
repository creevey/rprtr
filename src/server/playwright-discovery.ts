import { relative, resolve } from 'path'

import { z } from 'zod'

import { readPlaywrightListOutcome } from '../project-pins.ts'
import { safeParse } from '../schemas.ts'
import type { TestData } from '../types.ts'
import { browserLabelFromProjectName, relativeFileTokens } from '../vitest-helpers.ts'
import { DISCOVERED_ID_PREFIX } from './discovered-tests.ts'
import type { ListResult, ListSpawn } from './list-spawn.ts'

export interface PlaywrightListEntry {
  /** Absolute path to the test file, resolved from the report's rootDir-relative location. */
  file: string
  titlePath: string[]
  title: string
  /** Raw Playwright project name; '' for the implicit default project. */
  projectName: string
  line: number
  column?: number
}

// Leaf schemas for Playwright's JSON list report; the suite tree itself is
// walked structurally because its nesting has no fixed depth.
const PlaywrightListTestSchema = z.object({
  projectName: z.string(),
})

const PlaywrightListSpecSchema = z.object({
  title: z.string(),
  file: z.string().min(1),
  line: z.number(),
  column: z.number().optional(),
  tests: z.array(z.unknown()),
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** One entry per project test: a spec is listed once per project that runs it. */
function parseSpec(spec: unknown, titlePath: string[], rootDir: string): PlaywrightListEntry[] {
  const parsed = safeParse(PlaywrightListSpecSchema, spec)
  if (parsed === null) return []

  const file = resolve(rootDir, parsed.file)
  const entries: PlaywrightListEntry[] = []
  for (const rawTest of parsed.tests) {
    const parsedTest = safeParse(PlaywrightListTestSchema, rawTest)
    if (parsedTest === null) continue
    entries.push({
      file,
      titlePath,
      title: parsed.title,
      projectName: parsedTest.projectName,
      line: parsed.line,
      ...(parsed.column === undefined ? {} : { column: parsed.column }),
    })
  }
  return entries
}

function childrenOf(suite: Record<string, unknown>, key: 'specs' | 'suites'): unknown[] {
  const value = suite[key]
  return Array.isArray(value) ? value : []
}

/** Nested describe suites contribute their titles to the specs' title paths. */
function walkDescribeSuite(suite: unknown, titlePath: string[], rootDir: string, entries: PlaywrightListEntry[]): void {
  if (!isRecord(suite)) return

  const title = typeof suite.title === 'string' ? suite.title : ''
  const childPath = [...titlePath, title]
  for (const spec of childrenOf(suite, 'specs')) {
    entries.push(...parseSpec(spec, childPath, rootDir))
  }
  for (const child of childrenOf(suite, 'suites')) {
    walkDescribeSuite(child, childPath, rootDir, entries)
  }
}

/**
 * Flattens Playwright's `--list --reporter=json` report: each spec's location is
 * relative to `config.rootDir` (the project's testDir) and is resolved to an
 * absolute path here, so callers never depend on the report's cwd. Malformed
 * suites, specs, and tests are skipped rather than failing the listing.
 */
export function parsePlaywrightListReport(report: unknown): PlaywrightListEntry[] {
  if (!isRecord(report)) return []
  const config = report.config
  if (!isRecord(config) || typeof config.rootDir !== 'string' || config.rootDir === '') return []

  const entries: PlaywrightListEntry[] = []
  for (const fileSuite of Array.isArray(report.suites) ? report.suites : []) {
    if (!isRecord(fileSuite)) continue
    // The file suite's title is the file name, not part of the describe path.
    for (const spec of childrenOf(fileSuite, 'specs')) {
      entries.push(...parseSpec(spec, [], config.rootDir))
    }
    for (const child of childrenOf(fileSuite, 'suites')) {
      walkDescribeSuite(child, [], config.rootDir, entries)
    }
  }
  return entries
}

/**
 * Maps listed entries onto the tree the streamed results produce: `fileTokens`
 * relative to the config directory (the reporter's `configDir`), describe
 * suites from the nested title path, `pending` status, browser label from the
 * project name — '' falls back to `chromium`, matching the reporter's default
 * for unnamed projects — and a `discovered:`-prefixed id so provenance stays
 * explicit.
 */
export function synthesizePlaywrightDiscoveredTests(entries: PlaywrightListEntry[], configDir: string): TestData[] {
  const byId = new Map<string, TestData>()
  for (const entry of entries) {
    const relativeFile = relative(configDir, entry.file)
    const browser = browserLabelFromProjectName(entry.projectName, 'chromium')
    const id = `${DISCOVERED_ID_PREFIX}${relativeFile}:${browser}:${[...entry.titlePath, entry.title].join(' > ')}`
    if (byId.has(id)) continue

    byId.set(id, {
      id,
      fileTokens: relativeFileTokens(configDir, entry.file),
      titlePath: entry.titlePath,
      browser,
      projectName: entry.projectName,
      title: entry.title,
      location: {
        file: entry.file,
        line: entry.line,
        ...(entry.column === undefined ? {} : { column: entry.column }),
      },
      provider: 'playwright',
      status: 'pending',
    })
  }
  return [...byId.values()]
}

export interface RunPlaywrightListOptions {
  configFile: string
  cwd: string
  /** Kill the listing after this long; a hung listing yields an empty result. */
  timeoutMs?: number
  spawn?: ListSpawn
}

/**
 * Enumerates a Playwright project's tests via `playwright test --list
 * --reporter=json` — collection only, no browser launch. The command resolves
 * through the same package-manager resolution UI-launched runs use, and the
 * config path is passed explicitly so a server started with `--config` outside
 * the project lists the configured project. Failures — spawn error, malformed
 * output, non-zero exit, timeout — stay distinguishable from a genuinely empty
 * project so callers never erase a valid tree on a failed listing.
 */
export async function runPlaywrightList(options: RunPlaywrightListOptions): Promise<ListResult<PlaywrightListEntry>> {
  const outcome = await readPlaywrightListOutcome(options.cwd, {
    configFile: options.configFile,
    timeoutMs: options.timeoutMs,
    spawn: options.spawn,
  })
  if (outcome.failure !== null) return { ok: false, reason: outcome.failure }
  return { ok: true, entries: outcome.report === null ? [] : parsePlaywrightListReport(outcome.report) }
}
