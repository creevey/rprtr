import {
  BrowserPinValidationError,
  matchesVersionPrefix,
  parseBrowserPin,
  resolveProjectEnvironment,
  type BrowserManifest,
  type PinBrowser,
  type ProjectEnvironment,
  type ResolvedProjectPin,
  type RunEnvironments,
} from './browser-pins.ts'
import { playwrightImageTag } from './docker-image.ts'
import {
  readInstalledBrowserManifest,
  resolveInstalledExecutablePath,
  resolvePlaywrightVersion,
} from './playwright-install.ts'
import { PIN_BROWSERS, type BrowserPin } from './schemas/pins.ts'

const PIN_BROWSER_SET: ReadonlySet<string> = new Set(PIN_BROWSERS)

function isPinBrowser(value: string | undefined): value is PinBrowser {
  return value !== undefined && PIN_BROWSER_SET.has(value)
}

// ---------------------------------------------------------------------------
// Pin declaration reading
// ---------------------------------------------------------------------------

/** The resolved `provider` option of a Vitest browser project, as far as pins care about it. */
export interface VitestBrowserProviderLike {
  name?: string
  options?: {
    launchOptions?: { channel?: string; executablePath?: string }
    connectOptions?: { wsEndpoint?: string }
  }
}

/** Structural subset of Vitest's `TestProject` that pin resolution reads. */
export interface VitestBrowserProjectLike {
  name?: string
  config?: {
    root?: string
    browser?: {
      name?: string
      provider?: VitestBrowserProviderLike
    }
  }
}

/** A declaration-bearing project: the pin, the browser, and the launch path it resolves to. */
export interface VitestProjectPin extends ResolvedProjectPin {
  /** Directory whose installed `playwright` provides the version and browser manifest. */
  projectRoot: string
  /** Browser provider name from the resolved project config; absent when the config omits one. */
  provider?: string
  /** Remote endpoint the project connects to, if any. */
  wsEndpoint?: string
}

export interface ResolveVitestPinsInput {
  projects: readonly VitestBrowserProjectLike[]
  browserPin?: unknown
  browserPins?: unknown
}

export interface ResolvedVitestPins {
  /** One entry per browser-enabled project, in config order. */
  projects: VitestProjectPin[]
  /** Keyed pins whose key names no browser-enabled project of this run; warned about, never fatal. */
  unmatchedPins: Array<{ key: string; pin: BrowserPin }>
}

function parseKeyedPins(value: unknown): Record<string, BrowserPin> {
  if (value === undefined) return {}
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new BrowserPinValidationError(
      `Invalid crvyRprtr pin for option "browserPins": ${JSON.stringify(value)} — expected a map of project names to { browser, version } pins`,
    )
  }
  const pins: Record<string, BrowserPin> = {}
  for (const [key, entry] of Object.entries(value)) {
    const pin = parseBrowserPin(`browserPins["${key}"]`, entry)
    if (pin !== undefined) pins[key] = pin
  }
  return pins
}

/**
 * Maps Vitest browser projects to effective pins: `browserPins[project.name]`
 * overrides the `browserPin` fallback. Invalid pins — bad shape, bad browser
 * name, bad version, or a declared browser that disagrees with the project's
 * configured engine — throw `BrowserPinValidationError`. Keyed pins matching
 * no project of this run are returned for the caller to warn about: per-test
 * reruns filter projects, so the run may legitimately not contain the key.
 */
export function resolveVitestPins(input: ResolveVitestPinsInput): ResolvedVitestPins {
  const fallbackPin = parseBrowserPin('option "browserPin"', input.browserPin)
  const keyedPins = parseKeyedPins(input.browserPins)
  const projects: VitestProjectPin[] = []

  for (const project of input.projects) {
    const engine = project.config?.browser?.name
    if (!isPinBrowser(engine)) continue
    const projectName = project.name !== undefined && project.name !== '' ? project.name : engine
    const declared = keyedPins[projectName] ?? fallbackPin
    if (declared !== undefined && declared.browser !== engine) {
      throw new BrowserPinValidationError(
        `Invalid crvyRprtr pin for project "${projectName}": pin declares ${declared.browser} but the project configures ${engine}`,
      )
    }
    const provider = project.config?.browser?.provider
    const launchOptions = provider?.options?.launchOptions
    const wsEndpoint = provider?.options?.connectOptions?.wsEndpoint
    projects.push({
      projectName,
      browser: engine,
      projectRoot: project.config?.root ?? '',
      ...(provider?.name === undefined ? {} : { provider: provider.name }),
      ...(declared === undefined ? {} : { pin: declared }),
      ...(launchOptions?.channel === undefined || launchOptions.channel === ''
        ? {}
        : { channel: launchOptions.channel }),
      ...(launchOptions?.executablePath === undefined || launchOptions.executablePath === ''
        ? {}
        : { launchExecutablePath: launchOptions.executablePath }),
      ...(wsEndpoint === undefined || wsEndpoint === '' ? {} : { wsEndpoint }),
    })
  }

  const knownNames = new Set(projects.map((project) => project.projectName))
  const unmatchedPins = Object.entries(keyedPins)
    .filter(([key]) => !knownNames.has(key))
    .map(([key, pin]) => ({ key, pin }))

  return { projects, unmatchedPins }
}

// ---------------------------------------------------------------------------
// Effective environment resolution
// ---------------------------------------------------------------------------

export interface BuildVitestEnvironmentsInput {
  projects: readonly VitestProjectPin[]
  /** `CRVY_RPRTR_BROWSER_WS`: endpoint of the managed browser sidecar, when the run uses one. */
  browserWs?: string
  /** `CRVY_RPRTR_DOCKER_IMAGE`: image of the managed browser sidecar, when the run uses one. */
  dockerImage?: string
  /** Fixture seams; default to reading each project's installed Playwright. */
  manifest?: BrowserManifest | null
  playwrightVersion?: string | null
  executablePathFor?: (project: VitestProjectPin) => string | null
}

/** Module-private: the installed-Playwright facts resolution reads off one project root. */
interface InstalledContext {
  manifest: BrowserManifest
  playwrightVersion: string | null
}

function installedContext(root: string, input: BuildVitestEnvironmentsInput): InstalledContext {
  return {
    manifest:
      input.manifest === undefined
        ? (readInstalledBrowserManifest(root) ?? { browsers: [] })
        : (input.manifest ?? { browsers: [] }),
    playwrightVersion: input.playwrightVersion === undefined ? resolvePlaywrightVersion(root) : input.playwrightVersion,
  }
}

function hasRevisionOverrides(entry: BrowserManifest['browsers'][number]): boolean {
  return entry.revisionOverrides !== undefined && Object.keys(entry.revisionOverrides).length > 0
}

/** Unverifiable build: the reporter cannot observe what the project launches. */
function unverifiableEnvironment(input: {
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

/** Sidecar-backed run: the image's browsers come from the installed manifest's default revision. */
function sidecarEnvironment(input: {
  project: VitestProjectPin
  context: InstalledContext
  image: string
}): ProjectEnvironment {
  const { project, context } = input
  const entry = context.manifest.browsers.find((browser) => browser.name === project.browser)
  if (entry === undefined || hasRevisionOverrides(entry)) {
    return unverifiableEnvironment({ project, context, dockerImage: input.image })
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

function resolveVitestProjectEnvironment(
  project: VitestProjectPin,
  input: BuildVitestEnvironmentsInput,
): ProjectEnvironment {
  const root = project.projectRoot === '' ? process.cwd() : project.projectRoot
  const context = installedContext(root, input)
  const dockerImage = input.dockerImage
  const managedEndpoint = input.browserWs
  const managedImage =
    dockerImage !== undefined &&
    dockerImage !== '' &&
    context.playwrightVersion !== null &&
    dockerImage === playwrightImageTag(context.playwrightVersion)
  const sidecarBacked =
    managedImage && managedEndpoint !== undefined && managedEndpoint !== '' && project.wsEndpoint === managedEndpoint

  const unverifiable = (): ProjectEnvironment =>
    unverifiableEnvironment({ project, context, dockerImage: dockerImage === '' ? undefined : dockerImage })

  if (project.provider !== undefined && project.provider !== 'playwright') return unverifiable()

  if (project.wsEndpoint !== undefined) {
    if (!sidecarBacked || dockerImage === undefined || dockerImage === '') return unverifiable()
    return sidecarEnvironment({ project, context, image: dockerImage })
  }

  // A run carrying sidecar provenance that the project does not connect to
  // describes a different browser: the build is unobservable.
  if (managedEndpoint !== undefined && managedEndpoint !== '') return unverifiable()
  if (dockerImage !== undefined && dockerImage !== '') return unverifiable()

  if (project.channel !== undefined || project.launchExecutablePath !== undefined) return unverifiable()

  const entry = context.manifest.browsers.find((browser) => browser.name === project.browser)
  if (entry !== undefined && hasRevisionOverrides(entry)) return unverifiable()

  const executablePath =
    input.executablePathFor === undefined
      ? resolveInstalledExecutablePath(root, project.browser)
      : input.executablePathFor(project)
  if (executablePath === null) return unverifiable()

  return resolveProjectEnvironment({
    browser: project.browser,
    executablePath,
    manifest: context.manifest,
    playwrightVersion: context.playwrightVersion,
    ...(project.pin === undefined ? {} : { pin: project.pin }),
  })
}

/** Resolves the effective environment for every project, keyed by Vitest project name. */
export function buildVitestEnvironments(input: BuildVitestEnvironmentsInput): RunEnvironments {
  const environments: RunEnvironments = {}
  for (const project of input.projects) {
    environments[project.projectName] = resolveVitestProjectEnvironment(project, input)
  }
  return environments
}

/** Vitest drift remedy: the installed `playwright` (and image) that ships the pinned build. */
export function vitestPinRemedy(pin: BrowserPin): string {
  return `Install the playwright version that ships ${pin.browser} ${pin.version} — run \`crvy-rprtr browsers resolve ${pin.browser}@${pin.version}\` for the exact version and Docker image.`
}
