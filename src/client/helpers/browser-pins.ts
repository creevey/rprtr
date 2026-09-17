import type { BrowserPinStatus, ProjectEnvironment, RunEnvironments } from '../../schemas'
import type { CrvyRprtrTest } from '../../types'

export const pinStatusLabels: Record<BrowserPinStatus, string> = {
  pinned: 'Pinned',
  drift: 'Drift',
  unpinned: 'Unpinned',
  unverifiable: 'Unverifiable',
  unknown: 'Unknown',
}

export function pinStatusLabel(status: BrowserPinStatus): string {
  return pinStatusLabels[status]
}

/**
 * `unpinned` is the quiet default and `unknown` is data from artifacts without
 * environment fields — neither is worth a badge. `pinned`, `drift`, and
 * `unverifiable` all say something about the run.
 */
export function isVisiblePinStatus(status: BrowserPinStatus): boolean {
  return status === 'pinned' || status === 'drift' || status === 'unverifiable'
}

export function environmentForProject(
  environments: RunEnvironments | undefined,
  projectName: string | undefined,
): ProjectEnvironment | undefined {
  if (environments === undefined || projectName === undefined || projectName === '') return undefined
  return environments[projectName]
}

/** Looks a test's environment up by raw project name, then by browser label (default project). */
export function environmentForTest(
  environments: RunEnvironments | undefined,
  test: Pick<CrvyRprtrTest, 'browser' | 'projectName'>,
): ProjectEnvironment | undefined {
  return environmentForProject(environments, test.projectName) ?? environmentForProject(environments, test.browser)
}

export function testPinStatus(
  environments: RunEnvironments | undefined,
  test: Pick<CrvyRprtrTest, 'browser' | 'projectName'>,
): BrowserPinStatus {
  return environmentForTest(environments, test)?.status ?? 'unknown'
}

export function isDriftedTest(
  environments: RunEnvironments | undefined,
  test: Pick<CrvyRprtrTest, 'browser' | 'projectName'>,
): boolean {
  return testPinStatus(environments, test) === 'drift'
}

export function environmentBadgeEntries(
  environments: RunEnvironments | undefined,
): Array<[string, ProjectEnvironment]> {
  return Object.entries(environments ?? {}).filter(([, environment]) => isVisiblePinStatus(environment.status))
}

/** Human-readable tooltip for an environment badge. */
export function describeEnvironment(projectName: string, environment: ProjectEnvironment): string {
  const parts: string[] = []
  if (environment.browserVersion === null) {
    parts.push(`${projectName}: unverifiable on this platform`)
  } else {
    const revision = environment.revision === null ? '' : ` (revision ${environment.revision})`
    parts.push(`${projectName} ${environment.browserVersion}${revision} · ${pinStatusLabel(environment.status)}`)
  }
  if (environment.playwrightVersion !== null) {
    parts.push(`Playwright ${environment.playwrightVersion}`)
  }
  if (environment.dockerImage !== undefined) {
    parts.push(environment.dockerImage)
  }
  if (environment.pin !== undefined) {
    parts.push(`pins ${environment.pin.browser}@${environment.pin.version}`)
  }
  return parts.join(' · ')
}
