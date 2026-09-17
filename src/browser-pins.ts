import { readInstalledEnvironment, type BrowserManifest } from './playwright-install.ts'
import {
  BrowserPinSchema,
  PIN_BROWSERS,
  type BrowserPin,
  type BrowserPinStatus,
  type PinBrowser,
  type ProjectEnvironment,
} from './schemas/pins.ts'

export {
  BrowserPinSchema,
  BrowserPinStatusSchema,
  PIN_BROWSERS,
  ProjectEnvironmentSchema,
  RunEnvironmentsSchema,
  VersionPrefixSchema,
  isVersionPrefix,
} from './schemas/pins.ts'
export type { BrowserPin, BrowserPinStatus, PinBrowser, ProjectEnvironment, RunEnvironments } from './schemas/pins.ts'
export {
  BrowserManifestSchema,
  buildRunEnvironments,
  readInstalledBrowserManifest,
  readInstalledEnvironment,
  resolvePlaywrightVersion,
} from './playwright-install.ts'
export type {
  BrowserManifest,
  BuildRunEnvironmentsInput,
  ReadInstalledEnvironmentOptions,
} from './playwright-install.ts'

/**
 * Segment-wise prefix match: every provided pin segment must equal the
 * corresponding build segment (numerically), omitted trailing segments match
 * anything. `147` and `147.0` match `147.0.7727.15`; `147.0.77` does not.
 */
export function matchesVersionPrefix(prefix: string, version: string): boolean {
  const pinSegments = prefix.split('.')
  const buildSegments = version.split('.')
  if (pinSegments.length > buildSegments.length) return false
  return pinSegments.every((segment, index) => {
    const build = buildSegments[index]
    return build !== undefined && Number(segment) === Number(build)
  })
}

// ---------------------------------------------------------------------------
// Pin declaration reading
// ---------------------------------------------------------------------------

export class BrowserPinValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BrowserPinValidationError'
  }
}

export interface PlaywrightProjectLike {
  name?: string
  metadata?: unknown
  use?: {
    browserName?: string
    channel?: string
    launchOptions?: { executablePath?: string }
  }
}

export interface ResolvedProjectPin {
  /** Display name: the raw project name, or the browser engine for the implicit default project. */
  projectName: string
  browser: PinBrowser
  pin?: BrowserPin
  channel?: string
  launchExecutablePath?: string
}

const PIN_BROWSER_SET: ReadonlySet<string> = new Set(PIN_BROWSERS)

function isPinBrowser(value: string): value is PinBrowser {
  return PIN_BROWSER_SET.has(value)
}

function crvyRprtrMetadata(metadata: unknown): unknown {
  if (typeof metadata !== 'object' || metadata === null) return undefined
  return 'crvyRprtr' in metadata ? metadata.crvyRprtr : undefined
}

function parseDeclaredPin(owner: string, value: unknown): BrowserPin | undefined {
  if (value === undefined) return undefined
  const parsed = BrowserPinSchema.safeParse(value)
  if (!parsed.success) {
    throw new BrowserPinValidationError(
      `Invalid crvyRprtr pin for project "${owner}": ${JSON.stringify(value)} — browser must be one of ${PIN_BROWSERS.join(', ')} and version must be one or more dot-separated numeric segments (for example "147")`,
    )
  }
  return parsed.data
}

/**
 * Reads a browser pin from each project's `metadata.crvyRprtr`, falling back to
 * the config root's `metadata.crvyRprtr`. Invalid pins — bad shape, bad browser
 * name, bad version, or a declared browser that disagrees with the project's
 * configured browser — throw at reporter init instead of drifting silently.
 */
export function resolveProjectPins(input: {
  configMetadata?: unknown
  projects: readonly PlaywrightProjectLike[]
}): ResolvedProjectPin[] {
  const configPin = parseDeclaredPin('config', crvyRprtrMetadata(input.configMetadata))
  return input.projects.map((project) => {
    const browserName = project.use?.browserName
    const configuredBrowser = browserName !== undefined && isPinBrowser(browserName) ? browserName : undefined
    const projectName =
      project.name !== undefined && project.name !== '' ? project.name : (configuredBrowser ?? 'chromium')
    const declared = parseDeclaredPin(projectName, crvyRprtrMetadata(project.metadata)) ?? configPin
    if (declared !== undefined && configuredBrowser !== undefined && configuredBrowser !== declared.browser) {
      throw new BrowserPinValidationError(
        `Invalid crvyRprtr pin for project "${projectName}": pin declares ${declared.browser} but the project configures ${configuredBrowser}`,
      )
    }
    const channel = project.use?.channel
    const launchExecutablePath = project.use?.launchOptions?.executablePath
    return {
      projectName,
      browser: declared?.browser ?? configuredBrowser ?? 'chromium',
      ...(declared === undefined ? {} : { pin: declared }),
      ...(channel === undefined || channel === '' ? {} : { channel }),
      ...(launchExecutablePath === undefined || launchExecutablePath === '' ? {} : { launchExecutablePath }),
    }
  })
}

// ---------------------------------------------------------------------------
// Effective environment resolution
// ---------------------------------------------------------------------------

export interface ResolveProjectEnvironmentInput {
  browser: PinBrowser
  /** Effective executable path reported by `BrowserType.executablePath()`. */
  executablePath: string
  manifest: BrowserManifest
  playwrightVersion?: string | null
  dockerImage?: string
  pin?: BrowserPin
  /** Branded browser channel; the launched build is not Playwright's bundled one. */
  channel?: string
  /** Explicit `launchOptions.executablePath` override. */
  launchExecutablePath?: string
}

/** Extracts the effective revision from the `ms-playwright/<browser>-<revision>` directory in an executable path. */
export function parseRevisionFromExecutablePath(executablePath: string, browser: PinBrowser): string | null {
  const pattern = new RegExp(`^${browser}-(\\d+)$`)
  for (const segment of executablePath.split(/[\\/]/)) {
    const match = pattern.exec(segment)
    if (match !== null) return match[1] ?? null
  }
  return null
}

/**
 * Resolves the browser build a project actually renders with, offline.
 * The manifest only associates a version with its default revision: when the
 * effective revision differs (platform `revisionOverrides`), or the project
 * launches a non-bundled executable, the build is unverifiable — never drift.
 */
export function resolveProjectEnvironment(input: ResolveProjectEnvironmentInput): ProjectEnvironment {
  const revision = parseRevisionFromExecutablePath(input.executablePath, input.browser)
  const base: ProjectEnvironment = {
    playwrightVersion: input.playwrightVersion ?? null,
    browser: input.browser,
    browserVersion: null,
    revision,
    ...(input.dockerImage === undefined ? {} : { dockerImage: input.dockerImage }),
    ...(input.pin === undefined ? {} : { pin: input.pin }),
    status: input.pin === undefined ? 'unpinned' : 'unverifiable',
  }

  const launchesOwnBuild =
    (input.channel !== undefined && input.channel !== '') ||
    (input.launchExecutablePath !== undefined && input.launchExecutablePath !== '')
  if (launchesOwnBuild) return base

  const entry = input.manifest.browsers.find((browser) => browser.name === input.browser)
  if (entry === undefined || entry.revision !== revision) return base

  const browserVersion = entry.browserVersion ?? null
  if (browserVersion === null) return base

  const resolved: ProjectEnvironment = { ...base, browserVersion }
  if (input.pin === undefined) return { ...resolved, status: 'unpinned' }
  return {
    ...resolved,
    status: matchesVersionPrefix(input.pin.version, browserVersion) ? 'pinned' : 'drift',
  }
}

// ---------------------------------------------------------------------------
// Pin policy
// ---------------------------------------------------------------------------

export const BROWSER_PIN_POLICIES = ['warn', 'fail'] as const

export type BrowserPinPolicy = (typeof BROWSER_PIN_POLICIES)[number]

export type PinPolicyDecision =
  | { action: 'none' }
  | { action: 'warn'; message: string }
  | { action: 'fail'; message: string }

export interface EvaluateBrowserPinPolicyInput {
  policy: BrowserPinPolicy
  projectName: string
  environment: ProjectEnvironment
  /** Overrides the default remedy in failure/warning messages (e.g. a Docker image tag). */
  remedy?: string
}

/** Default remedy for drift: the exact Playwright release (and Docker image) that ships the pinned build. */
export function defaultPinRemedy(pin: BrowserPin): string {
  return `Install the @playwright/test version that ships ${pin.browser} ${pin.version} — run \`crvy-rprtr browsers resolve ${pin.browser}@${pin.version}\` for the exact version and Docker image.`
}

/**
 * Only drift is actionable: `pinned` needs nothing, and `unpinned`/`unverifiable`
 * cannot be judged because no observable build is associated with the run.
 */
export function evaluateBrowserPinPolicy(input: EvaluateBrowserPinPolicyInput): PinPolicyDecision {
  const { environment } = input
  const pin = environment.pin
  if (environment.status !== 'drift' || pin === undefined) return { action: 'none' }

  const revision = environment.revision === null ? '' : ` (revision ${environment.revision})`
  const message = `Project "${input.projectName}" pins ${pin.browser}@${pin.version} but the effective browser build is ${environment.browserVersion ?? 'unknown'}${revision}. ${input.remedy ?? defaultPinRemedy(pin)}`
  return { action: input.policy === 'fail' ? 'fail' : 'warn', message }
}

export interface DockerPinCheckInput {
  cwd: string
  projects: readonly ResolvedProjectPin[]
  executablePathFor: (browser: PinBrowser) => string
  /** Docker image tag the run would use. */
  image: string
}

/**
 * Rejects a Docker run whose declared pins the installed Playwright cannot
 * satisfy, before any container starts. Unpinned and unverifiable projects
 * pass: only observable drift blocks.
 */
export function checkDockerPins(input: DockerPinCheckInput): { ok: true } | { ok: false; message: string } {
  const failures: string[] = []
  for (const project of input.projects) {
    const pin = project.pin
    if (pin === undefined) continue
    const environment = readInstalledEnvironment({
      cwd: input.cwd,
      browser: project.browser,
      executablePath: input.executablePathFor(project.browser),
      pin,
      dockerImage: input.image,
      ...(project.channel === undefined ? {} : { channel: project.channel }),
      ...(project.launchExecutablePath === undefined ? {} : { launchExecutablePath: project.launchExecutablePath }),
    })
    const decision = evaluateBrowserPinPolicy({
      policy: 'fail',
      projectName: project.projectName,
      environment,
      remedy: `The run's Docker image is ${input.image}; use the Playwright image that ships ${pin.browser} ${pin.version} (run \`crvy-rprtr browsers resolve ${pin.browser}@${pin.version}\` for the exact tag).`,
    })
    if (decision.action === 'fail') failures.push(decision.message)
  }
  return failures.length === 0 ? { ok: true } : { ok: false, message: failures.join('\n') }
}
