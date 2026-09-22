import { join } from 'path'

import { fileExists } from './file-utils.ts'
import { resolveSeedConfigFile } from './playwright-config.ts'
import type { RunContext } from './run-controller.ts'

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
