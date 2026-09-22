import { evaluateBrowserPinPolicy, type BrowserPinPolicy, type RunEnvironments } from './browser-pins.ts'
import {
  buildVitestEnvironments,
  resolveVitestPins,
  vitestPinRemedy,
  type BuildVitestEnvironmentsInput,
  type VitestBrowserProjectLike,
} from './vitest-pins.ts'

export interface ResolveVitestRunEnvironmentsInput {
  projects: readonly VitestBrowserProjectLike[]
  browserPin?: unknown
  browserPins?: unknown
  policy: BrowserPinPolicy
  /** Warning sink for unmatched keys and the warn policy; defaults to console.warn. */
  warn?: (message: string) => void
  /** Fixture seams forwarded to the environment builder. */
  manifest?: BuildVitestEnvironmentsInput['manifest']
  playwrightVersion?: string | null
  executablePathFor?: BuildVitestEnvironmentsInput['executablePathFor']
}

/** Reads the managed-sidecar env vars the server exports for Vitest docker runs. */
function sidecarEnv(): { browserWs?: string; dockerImage?: string } {
  return {
    ...(process.env.CRVY_RPRTR_BROWSER_WS === undefined ? {} : { browserWs: process.env.CRVY_RPRTR_BROWSER_WS }),
    ...(process.env.CRVY_RPRTR_DOCKER_IMAGE === undefined ? {} : { dockerImage: process.env.CRVY_RPRTR_DOCKER_IMAGE }),
  }
}

/**
 * Resolves the declared Vitest pins, the effective build of every browser
 * project, and applies the pin policy. Invalid pins throw here — before any
 * browser starts; unmatched keyed pins warn once and are ignored for this run.
 */
export function resolveVitestRunEnvironments(input: ResolveVitestRunEnvironmentsInput): RunEnvironments {
  const warn =
    input.warn ??
    ((message: string): void => {
      console.warn(message)
    })
  const { projects, unmatchedPins } = resolveVitestPins({
    projects: input.projects,
    browserPin: input.browserPin,
    browserPins: input.browserPins,
  })
  for (const { key } of unmatchedPins) {
    const known = projects.map((project) => project.projectName).join(', ')
    warn(
      `[CrvyRprtr] browserPins["${key}"] matches no browser project of this run (known projects: ${known === '' ? 'none' : known}); the pin is ignored. Run \`crvy-rprtr browsers check\` to validate the full config.`,
    )
  }

  const environments = buildVitestEnvironments({
    projects,
    ...sidecarEnv(),
    ...(input.manifest === undefined ? {} : { manifest: input.manifest }),
    ...(input.playwrightVersion === undefined ? {} : { playwrightVersion: input.playwrightVersion }),
    ...(input.executablePathFor === undefined ? {} : { executablePathFor: input.executablePathFor }),
  })
  for (const [projectName, environment] of Object.entries(environments)) {
    const decision = evaluateBrowserPinPolicy({
      policy: input.policy,
      projectName,
      environment,
      ...(environment.pin === undefined ? {} : { remedy: vitestPinRemedy(environment.pin) }),
    })
    if (decision.action === 'fail') throw new Error(decision.message)
    if (decision.action === 'warn') warn(`[CrvyRprtr] ${decision.message}`)
  }
  return environments
}
