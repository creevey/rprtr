import type { PinBrowser, ResolvedProjectPin } from '../browser-pins.ts'
import { DOCKER_BROWSER_REVISIONS_ENV, DOCKER_IMAGE_ENV } from '../docker-image.ts'
import type { ImageBrowserRevisions } from '../image-browsers.ts'
import type { RunTestDescriptor } from '../schemas.ts'
import type { ClientWebSocketMessage } from '../types.ts'
import { BROWSER_WS_ENV, hasBrowserEndpointHook, type BrowserSidecar } from './browser-sidecar.ts'
import { assertVitestDockerPinsSatisfied } from './docker-preflight.ts'
import { sharedProject } from './run-command-helpers.ts'
import type { RunContext } from './run-controller.ts'
import type { RunLauncher } from './run-launcher.ts'
import type { RunMode } from './run-mode.ts'

/** How a Vitest run reaches a browser under the configured run mode. */
export type VitestBackend = 'local' | 'sidecar' | { refusal: 'docker-missing-browser-hook' }

export interface ResolveVitestBackendInput {
  ctx: RunContext
  runMode: RunMode | undefined
  /** True when the startup resolution selected the docker launcher. */
  dockerBackend: boolean
  /** Warn about the auto-mode downgrade; prepare resolves without warning so start warns once. */
  warn: boolean
  hasHook?: (configFile: string) => boolean
  warnSink?: (message: string) => void
}

/**
 * Resolves the Vitest launch backend (D6): local mode — or auto mode whose
 * startup probe resolved to the local backend — launches locally; docker/auto
 * with a docker backend and the documented config hook launches local vitest
 * against the managed sidecar; explicit docker mode without the hook refuses.
 */
export function resolveVitestBackend(input: ResolveVitestBackendInput): VitestBackend {
  const runMode = input.runMode ?? 'local'
  if (runMode === 'local' || !input.dockerBackend) return 'local'
  const hasHook = (input.hasHook ?? hasBrowserEndpointHook)(input.ctx.configFile)
  if (hasHook) return 'sidecar'
  if (runMode === 'docker') return { refusal: 'docker-missing-browser-hook' }
  if (input.warn) {
    const sink =
      input.warnSink ??
      ((message: string): void => {
        console.warn(message)
      })
    sink(`[RunController] Docker skipped: the Vitest config does not reference ${BROWSER_WS_ENV}; launching locally.`)
  }
  return 'local'
}

export interface ResolveVitestLaunchPlanInput extends ResolveVitestBackendInput {
  /** Always-local launcher the run composes with, sidecar or not. */
  localLauncher: RunLauncher
  /** Ready sidecar endpoint from the last successful preparation, if any. */
  browserWs: string | null
}

export type VitestLaunchPlan =
  | { launcher: RunLauncher; mode: 'local' | 'docker' }
  | { refusal: 'docker-missing-browser-hook' }
  | { unavailable: true }

/**
 * Turns the resolved backend into the launcher + mode for a start request.
 * A sidecar backend without a prepared endpoint is unavailable: vitest must
 * not spawn until the sidecar accepts connections.
 */
export function resolveVitestLaunchPlan(input: ResolveVitestLaunchPlanInput): VitestLaunchPlan {
  const backend = resolveVitestBackend(input)
  if (typeof backend === 'object') return { refusal: backend.refusal }
  if (backend === 'sidecar' && input.browserWs === null) return { unavailable: true }
  return { launcher: input.localLauncher, mode: backend === 'sidecar' ? 'docker' : 'local' }
}

/**
 * Vitest selection flags: positional file filters, `--project` when every
 * requested test shares one project, and `-t` with the full title path for a
 * single test (Vitest matches `-t` against the full test name as substring).
 * No `--reporter` injection (the project's Vitest config carries the
 * reporter), no `--test-list` temp file, no Playwright version probe.
 */
export function buildVitestArgs(
  ctx: RunContext,
  filters: { update?: boolean },
  tests: RunTestDescriptor[] | undefined,
): string[] {
  const args = ['run', '--config', ctx.configFile]
  if (filters.update === true) args.push('--update')
  if (tests !== undefined && tests.length > 0) {
    const project = sharedProject(tests)
    if (project !== undefined) args.push(`--project=${project}`)
    for (const file of new Set(tests.map((t) => t.file))) args.push(file)
    if (tests.length === 1) {
      const only = tests[0]!
      args.push('-t', only.titlePath.join(' '))
    }
  }
  return args
}

/** Env the Vitest child needs to attribute a sidecar-backed run to its image and builds. */
export function buildVitestSidecarEnv(
  endpoint: string,
  image: string | null,
  browsers: ImageBrowserRevisions | null,
): Record<string, string> {
  return {
    [BROWSER_WS_ENV]: endpoint,
    ...(image === null ? {} : { [DOCKER_IMAGE_ENV]: image }),
    ...(browsers === null ? {} : { [DOCKER_BROWSER_REVISIONS_ENV]: JSON.stringify(browsers) }),
  }
}

export interface PrepareVitestSidecarInput {
  ctx: RunContext
  sidecar: BrowserSidecar | undefined
  broadcast: (message: ClientWebSocketMessage) => void
}

export interface PreparedVitestSidecar {
  ok: true
  endpoint: string
  image?: string
  browsers?: ImageBrowserRevisions
}

/**
 * Ensures the warm sidecar for a sidecar-backed Vitest run, broadcasting its
 * preparation phases on the docker run-status channel. A missing sidecar or a
 * failed ensure surfaces the existing docker-unavailable failure reason.
 */
export async function prepareVitestSidecar(
  input: PrepareVitestSidecarInput,
): Promise<PreparedVitestSidecar | { ok: false }> {
  if (input.sidecar === undefined) return { ok: false }
  try {
    const endpoint = await input.sidecar.ensure(input.ctx, (phase) => {
      input.broadcast({ type: 'run-status', data: { running: true, mode: 'docker', phase } })
    })
    let browsers: ImageBrowserRevisions | null = null
    try {
      browsers = await input.sidecar.browsers()
    } catch {
      // An unreadable image probe only downgrades pin verification.
    }
    return {
      ok: true,
      endpoint,
      ...(input.sidecar.image === undefined ? {} : { image: input.sidecar.image }),
      ...(browsers === null ? {} : { browsers }),
    }
  } catch (error) {
    input.broadcast({ type: 'run-status', data: { running: false, mode: 'docker' } })
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`[RunController] browser sidecar preparation failed: ${message}`)
    return { ok: false }
  }
}

export interface PrepareVitestSidecarRunInput {
  ctx: RunContext
  sidecar: BrowserSidecar | undefined
  /** Injected pin reader for the preflight; defaults to the project's Vitest config. */
  readVitestPins?: (cwd: string) => Promise<readonly ResolvedProjectPin[]>
  /** Installed executable paths for the preflight; defaults to the project's Playwright. */
  browserExecutablePaths?: (cwd: string) => Record<PinBrowser, string> | null
  warn: (message: string) => void
  broadcast: (message: ClientWebSocketMessage) => void
}

/**
 * Preflights declared Vitest pins against the sidecar image, then ensures the
 * warm sidecar. The image resolves before the container starts, so a drifting
 * pin rejects the run with the matching image tag as the remedy.
 */
export async function prepareVitestSidecarRun(
  input: PrepareVitestSidecarRunInput,
): Promise<PreparedVitestSidecar | { ok: false }> {
  const resolvedImage = input.sidecar?.resolveImage(input.ctx) ?? null
  if (resolvedImage !== null) {
    try {
      await assertVitestDockerPinsSatisfied({
        cwd: input.ctx.cwd,
        image: resolvedImage,
        warn: input.warn,
        ...(input.readVitestPins === undefined ? {} : { readVitestPins: input.readVitestPins }),
        ...(input.browserExecutablePaths === undefined ? {} : { browserExecutablePaths: input.browserExecutablePaths }),
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      input.warn(`[RunController] Vitest browser pin preflight failed: ${message}`)
      return { ok: false }
    }
  }
  const prepared = await prepareVitestSidecar({ ctx: input.ctx, sidecar: input.sidecar, broadcast: input.broadcast })
  if (!prepared.ok) return { ok: false }
  const image = prepared.image ?? resolvedImage
  return {
    ok: true,
    endpoint: prepared.endpoint,
    ...(image === null ? {} : { image }),
    ...(prepared.browsers === undefined ? {} : { browsers: prepared.browsers }),
  }
}
