import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

import { z } from 'zod'

import {
  resolveProjectEnvironment,
  type ResolveProjectEnvironmentInput,
  type ResolvedProjectPin,
  type ProjectEnvironment,
  type RunEnvironments,
} from './browser-pins.ts'
import type { PinBrowser } from './schemas/pins.ts'

const BrowserManifestEntrySchema = z.object({
  name: z.string(),
  revision: z.string(),
  browserVersion: z.string().optional(),
  revisionOverrides: z.record(z.string(), z.string()).optional(),
  installByDefault: z.boolean().optional(),
})

export const BrowserManifestSchema = z.object({
  browsers: z.array(BrowserManifestEntrySchema),
})

export type BrowserManifest = z.infer<typeof BrowserManifestSchema>

/** Reads the installed Playwright's own browser manifest; null when unresolvable. */
export function readInstalledBrowserManifest(cwd: string): BrowserManifest | null {
  try {
    const req = createRequire(join(cwd, 'package.json'))
    const pkgPath = req.resolve('playwright-core/package.json')
    const raw: unknown = JSON.parse(readFileSync(join(dirname(pkgPath), 'browsers.json'), 'utf8'))
    const parsed = BrowserManifestSchema.safeParse(raw)
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/** Module-private: resolution order shared by the version probe and the sidecar CLI selection. */
const PLAYWRIGHT_PACKAGES = ['playwright', '@playwright/test'] as const

function readPackageVersion(req: ReturnType<typeof createRequire>, name: string): string | null {
  try {
    const pkgPath = req.resolve(`${name}/package.json`)
    const pkg: unknown = JSON.parse(readFileSync(pkgPath, 'utf8'))
    return typeof pkg === 'object' && pkg !== null && 'version' in pkg && typeof pkg.version === 'string'
      ? pkg.version
      : null
  } catch {
    return null
  }
}

/**
 * Reads the installed Playwright version from cwd, trying `playwright` first
 * (Vitest browser projects configure the provider from it) and falling back to
 * `@playwright/test`; null when unresolvable.
 */
export function resolvePlaywrightVersion(cwd: string): string | null {
  const req = createRequire(join(cwd, 'package.json'))
  for (const name of PLAYWRIGHT_PACKAGES) {
    const version = readPackageVersion(req, name)
    if (version !== null) return version
  }
  return null
}

export interface ReadInstalledEnvironmentOptions extends Omit<
  ResolveProjectEnvironmentInput,
  'manifest' | 'playwrightVersion'
> {
  cwd: string
}

/** Combines installed-version, manifest, and executable-path resolution for one project. */
export function readInstalledEnvironment(options: ReadInstalledEnvironmentOptions): ProjectEnvironment {
  const { cwd, ...rest } = options
  return resolveProjectEnvironment({
    ...rest,
    manifest: readInstalledBrowserManifest(cwd) ?? { browsers: [] },
    playwrightVersion: resolvePlaywrightVersion(cwd),
  })
}

export interface BuildRunEnvironmentsInput {
  /** Directory whose installed Playwright provides the version and browser manifest. */
  cwd: string
  projects: readonly ResolvedProjectPin[]
  executablePathFor: (browser: PinBrowser) => string
  dockerImage?: string
  /** Fixture seams; default to reading the installed Playwright. */
  manifest?: BrowserManifest | null
  playwrightVersion?: string | null
}

/** Resolves the effective environment for every project, keyed by project display name. */
export function buildRunEnvironments(input: BuildRunEnvironmentsInput): RunEnvironments {
  const manifest =
    input.manifest === undefined ? (readInstalledBrowserManifest(input.cwd) ?? { browsers: [] }) : input.manifest
  const playwrightVersion =
    input.playwrightVersion === undefined ? resolvePlaywrightVersion(input.cwd) : input.playwrightVersion
  const environments: RunEnvironments = {}
  for (const project of input.projects) {
    environments[project.projectName] = resolveProjectEnvironment({
      browser: project.browser,
      executablePath: input.executablePathFor(project.browser),
      manifest: manifest ?? { browsers: [] },
      playwrightVersion,
      ...(project.pin === undefined ? {} : { pin: project.pin }),
      ...(project.channel === undefined ? {} : { channel: project.channel }),
      ...(project.launchExecutablePath === undefined ? {} : { launchExecutablePath: project.launchExecutablePath }),
      ...(input.dockerImage === undefined ? {} : { dockerImage: input.dockerImage }),
    })
  }
  return environments
}
