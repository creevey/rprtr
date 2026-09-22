import { checkDockerPins, type PinBrowser, type ResolvedProjectPin } from '../browser-pins.ts'
import { resolveBrowserExecutablePaths } from '../playwright-install.ts'
import {
  parseProjectPinsFromListReport,
  readPlaywrightListWithConfig,
  readProjectPinsFromConfig,
} from '../project-pins.ts'
import { readVitestProjectPins } from '../vitest-project-pins.ts'
import type { DockerConfigSummary } from './config-dump.ts'
import type { Warn } from './docker-support.ts'

/** Rejects a Docker run whose declared pins the installed Playwright cannot satisfy. */
export class DockerPinDriftError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DockerPinDriftError'
  }
}

export interface DockerPinPreflightDeps {
  cwd: string
  image: string
  warn: Warn
  /** Injectable pin reader for tests; defaults to the dump-aware listing. */
  readProjectPins?: (cwd: string) => Promise<readonly ResolvedProjectPin[]>
  /**
   * Injectable config-summary reader for tests. When absent and `readProjectPins` is
   * not injected, the pins reader default also produces the summary from one spawn.
   */
  readConfigSummary?: (cwd: string) => Promise<DockerConfigSummary | null>
  browserExecutablePaths?: Partial<Record<PinBrowser, string>>
}

/** Diagnostics must not fail the preflight: an unreadable summary degrades to null. */
async function readConfigSummarySafe(
  read: (cwd: string) => Promise<DockerConfigSummary | null>,
  cwd: string,
): Promise<DockerConfigSummary | null> {
  try {
    return await read(cwd)
  } catch {
    return null
  }
}

async function loadBrowserExecutablePaths(
  overrides?: Partial<Record<PinBrowser, string>>,
): Promise<Record<PinBrowser, string>> {
  if (overrides?.chromium !== undefined && overrides.firefox !== undefined && overrides.webkit !== undefined) {
    return { chromium: overrides.chromium, firefox: overrides.firefox, webkit: overrides.webkit }
  }
  const { chromium, firefox, webkit } = await import('@playwright/test')
  return {
    chromium: overrides?.chromium ?? chromium.executablePath(),
    firefox: overrides?.firefox ?? firefox.executablePath(),
    webkit: overrides?.webkit ?? webkit.executablePath(),
  }
}

/**
 * Rejects the run when a declared pin cannot be satisfied by the installed
 * Playwright's browsers — before any container starts. Returns the resolved config
 * summary for host-service diagnostics; null when unavailable. Config reading
 * failures degrade to a warning: an unreadable config must not block docker runs.
 */
export async function assertDockerPinsSatisfied(deps: DockerPinPreflightDeps): Promise<DockerConfigSummary | null> {
  let projects: readonly ResolvedProjectPin[] = []
  let config: DockerConfigSummary | null = null
  try {
    const readPins = deps.readProjectPins
    if (deps.readConfigSummary !== undefined) {
      config = await readConfigSummarySafe(deps.readConfigSummary, deps.cwd)
      projects = readPins === undefined ? await readProjectPinsFromConfig(deps.cwd) : await readPins(deps.cwd)
    } else if (readPins === undefined) {
      const listed = await readPlaywrightListWithConfig(deps.cwd)
      config = listed.config
      projects = listed.report === null ? [] : parseProjectPinsFromListReport(listed.report)
    } else {
      projects = await readPins(deps.cwd)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    deps.warn(`Could not read browser pins from the Playwright config: ${message}`)
    return config
  }
  if (!projects.some((project) => project.pin !== undefined)) return config

  const executablePaths = await loadBrowserExecutablePaths(deps.browserExecutablePaths)
  const check = checkDockerPins({
    cwd: deps.cwd,
    projects,
    image: deps.image,
    executablePathFor: (browser) => executablePaths[browser],
  })
  if (!check.ok) throw new DockerPinDriftError(check.message)
  return config
}

export interface VitestDockerPinPreflightDeps {
  cwd: string
  image: string
  warn: Warn
  readVitestPins?: (cwd: string) => Promise<readonly ResolvedProjectPin[]>
  browserExecutablePaths?: (cwd: string) => Record<PinBrowser, string> | null
}

/**
 * Rejects a sidecar-backed Vitest run whose declared pins the sidecar image
 * cannot satisfy, before the container starts. Unpinned and unverifiable
 * projects pass; an unreadable config degrades to a warning — it must not
 * block runs it cannot speak for.
 */
export async function assertVitestDockerPinsSatisfied(deps: VitestDockerPinPreflightDeps): Promise<void> {
  const readPins = deps.readVitestPins ?? readVitestProjectPins
  let projects: readonly ResolvedProjectPin[]
  try {
    projects = await readPins(deps.cwd)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    deps.warn(`Could not read browser pins from the Vitest config: ${message}`)
    return
  }
  const pinned = projects.some(
    (project) => project.pin !== undefined && project.invalidReason === undefined && project.unverifiable !== true,
  )
  if (!pinned) return

  const executablePaths =
    deps.browserExecutablePaths === undefined
      ? resolveBrowserExecutablePaths(deps.cwd)
      : deps.browserExecutablePaths(deps.cwd)
  if (executablePaths === null) {
    deps.warn('Could not resolve the installed Playwright browsers for the Vitest pin preflight.')
    return
  }
  const check = checkDockerPins({
    cwd: deps.cwd,
    projects,
    image: deps.image,
    executablePathFor: (browser) => executablePaths[browser],
  })
  if (!check.ok) throw new DockerPinDriftError(check.message)
}
