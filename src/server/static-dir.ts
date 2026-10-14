import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

import { fileExists } from './file-utils.ts'

/**
 * Resolves the built web UI assets directory: the explicit override (or its
 * `dist` child) when given, otherwise the first candidate containing an
 * `index.html`, walking from this module's location outwards. Falls back to
 * this module's directory so a missing build still yields a usable path.
 */
export async function resolveStaticDir(staticDir?: string): Promise<string> {
  const currentDir = dirname(fileURLToPath(import.meta.url))
  const candidates =
    staticDir === undefined
      ? [
          currentDir,
          join(currentDir, 'dist'),
          join(currentDir, '..', 'dist'),
          join(currentDir, '..', '..', 'dist'),
          join(currentDir, '..'),
          join(currentDir, '..', '..'),
        ]
      : [staticDir, join(staticDir, 'dist')]

  const resolvedCandidates = await Promise.all(
    candidates.map(async (candidate) => ({
      candidate,
      exists: await fileExists(join(candidate, 'index.html')),
    })),
  )

  const resolved = resolvedCandidates.find(({ exists }) => exists)
  if (resolved !== undefined) {
    return resolved.candidate
  }

  return candidates[0]!
}
