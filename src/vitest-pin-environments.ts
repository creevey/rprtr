import { matchesVersionPrefix, type BrowserManifest, type ProjectEnvironment } from './browser-pins.ts'
import type { VitestProjectPin } from './vitest-pins.ts'

/** Installed-Playwright facts shared by local and sidecar environment resolution. */
export interface InstalledContext {
  manifest: BrowserManifest
  playwrightVersion: string | null
}

export function hasRevisionOverrides(entry: BrowserManifest['browsers'][number]): boolean {
  return entry.revisionOverrides !== undefined && Object.keys(entry.revisionOverrides).length > 0
}

/** Unverifiable build: the reporter cannot observe what the project launches. */
export function unverifiableEnvironment(input: {
  project: VitestProjectPin
  context: InstalledContext
  dockerImage?: string | undefined
}): ProjectEnvironment {
  const { project, context } = input
  return {
    playwrightVersion: context.playwrightVersion,
    browser: project.browser,
    browserVersion: null,
    revision: null,
    ...(input.dockerImage === undefined || input.dockerImage === '' ? {} : { dockerImage: input.dockerImage }),
    ...(project.pin === undefined ? {} : { pin: project.pin }),
    status: project.pin === undefined ? 'unpinned' : 'unverifiable',
  }
}

export interface SidecarEnvironmentInput {
  project: VitestProjectPin
  context: InstalledContext
  image: string
  /** Revisions probed from the image; absent for the canonical image without a probe. */
  observedRevisions?: readonly string[]
}

/**
 * Sidecar-backed run: the image's browsers come from the installed manifest's
 * default revision. With a probed custom image the observed revisions are the
 * source of truth; a canonical image without a probe keeps the conservative
 * no-`revisionOverrides` rule.
 */
export function sidecarEnvironment(input: SidecarEnvironmentInput): ProjectEnvironment {
  const { project, context, observedRevisions } = input
  const entry = context.manifest.browsers.find((browser) => browser.name === project.browser)
  if (entry === undefined) {
    return unverifiableEnvironment({ project, context, dockerImage: input.image })
  }
  const unverifiable = (): ProjectEnvironment => unverifiableEnvironment({ project, context, dockerImage: input.image })

  if (observedRevisions === undefined) {
    if (hasRevisionOverrides(entry)) return unverifiable()
  } else {
    const overrideRevisions = Object.values(entry.revisionOverrides ?? {})
    const usesOverride = overrideRevisions.some((revision) => observedRevisions.includes(revision))
    if (usesOverride || !observedRevisions.includes(entry.revision)) return unverifiable()
  }

  const browserVersion = entry.browserVersion ?? null
  const status =
    project.pin === undefined
      ? 'unpinned'
      : browserVersion === null
        ? 'unverifiable'
        : matchesVersionPrefix(project.pin.version, browserVersion)
          ? 'pinned'
          : 'drift'
  return {
    playwrightVersion: context.playwrightVersion,
    browser: project.browser,
    browserVersion,
    revision: entry.revision,
    dockerImage: input.image,
    ...(project.pin === undefined ? {} : { pin: project.pin }),
    status,
  }
}
