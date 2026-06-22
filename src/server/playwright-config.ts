import { join } from 'path'

import { fileExists } from './file-utils.ts'

// Filenames Playwright accepts as a config, checked in priority order. The
// reporter overwrites this with Playwright's own resolution once a run starts,
// so discovery only needs to find a valid config to enable the run button
// before any reporter has registered.
const CONFIG_FILES = [
  'playwright.config.ts',
  'playwright.config.mts',
  'playwright.config.cts',
  'playwright.config.js',
  'playwright.config.mjs',
  'playwright.config.cjs',
]

export async function resolvePlaywrightConfig(cwd: string): Promise<string | null> {
  const matches = await Promise.all(
    CONFIG_FILES.map(async (file) => {
      const candidate = join(cwd, file)
      return (await fileExists(candidate)) ? candidate : null
    }),
  )
  // find() preserves CONFIG_FILES priority order (first existing file wins).
  return matches.find((path): path is string => path !== null) ?? null
}
