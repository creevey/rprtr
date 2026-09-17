import { join } from 'path'

import type { ClientWebSocketMessage, TestData } from '../types.ts'
import { fileExists } from './file-utils.ts'
import { resolveSeedConfigFile } from './playwright-config.ts'
import type { RunContext } from './run-controller.ts'
import { DISCOVERED_ID_PREFIX, mergeDiscoveredTests, runVitestList } from './vitest-discovery.ts'

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

/**
 * The persisted view of the report state: discovered-but-never-run entries are
 * filtered out so report.json — and through it offline JSON review and the
 * static HTML artifact — stays derived from actual run events only.
 */
export function withoutDiscoveredTests<T extends { tests: Record<string, TestData> }>(data: T): T {
  if (!hasDiscoveredIds(data.tests)) return data
  return { ...data, tests: filterDiscoveredIds(data.tests) }
}

function hasDiscoveredIds(tests: Record<string, TestData>): boolean {
  return Object.keys(tests).some((id) => id.startsWith(DISCOVERED_ID_PREFIX))
}

function filterDiscoveredIds(tests: Record<string, TestData>): Record<string, TestData> {
  return Object.fromEntries(Object.entries(tests).filter(([id]) => !id.startsWith(DISCOVERED_ID_PREFIX)))
}
