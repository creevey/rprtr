import { existsSync, readFileSync } from 'node:fs'

import { formatRecord, type DebugLogger } from '../debug-log.ts'
import { resolvePlaywrightVersion } from '../playwright-install.ts'
import { type DockerOptions } from './docker-launcher.ts'
import { buildBrowserSidecarRunArgs, resolveSidecarCommand } from './docker-run-args.ts'
import {
  createDockerExec,
  DockerUnavailableError,
  forceRemoveContainer,
  isDockerImagePresent,
  probeDockerDaemon,
  pullDockerImage,
  resolveDockerImage,
  type DockerExec,
} from './docker-support.ts'
import { recordSidecarFailure, type SidecarEvidenceDeps } from './sidecar-evidence.ts'
import { resolvePublishedPort, tcpProbe, waitForEndpoint } from './sidecar-readiness.ts'

/** Env var a project's Vitest config reads to point the playwright provider at a remote browser. */
export const BROWSER_WS_ENV = 'CRVY_RPRTR_BROWSER_WS'

/** Port `playwright run-server` listens on inside the sidecar container. */
export const BROWSER_SIDECAR_PORT = 6677

/**
 * Textual scan of the Vitest config for the documented browser-endpoint hook
 * (D2): a present env var name always means the config can compose with the
 * sidecar; indirect reads are false negatives, which only downgrade auto runs.
 * An unreadable config counts as absent.
 */
export function hasBrowserEndpointHook(configFile: string): boolean {
  try {
    return readFileSync(configFile, 'utf8').includes(BROWSER_WS_ENV)
  } catch {
    return false
  }
}

const READINESS_TIMEOUT_MS = 15000
const READINESS_INTERVAL_MS = 250

/**
 * Debug-only preparation-phase record: emits start, then completed or failed
 * with the elapsed time. With debug off the wrapped work runs untouched, so
 * the preparation path is byte-identical.
 */
async function runPhase<T>(debug: DebugLogger | undefined, name: string, run: () => Promise<T>): Promise<T> {
  if (debug?.enabled !== true) return run()
  const startedAt = Date.now()
  debug.log(formatRecord('BrowserSidecar', { event: 'phase', phase: name, status: 'start' }))
  try {
    const result = await run()
    debug.log(
      formatRecord('BrowserSidecar', {
        event: 'phase',
        phase: name,
        status: 'completed',
        durationMs: Date.now() - startedAt,
      }),
    )
    return result
  } catch (error) {
    debug.log(
      formatRecord('BrowserSidecar', {
        event: 'phase',
        phase: name,
        status: 'failed',
        durationMs: Date.now() - startedAt,
      }),
    )
    throw error
  }
}

export interface BrowserSidecar {
  /** Endpoint of the warm sidecar, if one is currently ready. */
  readonly endpoint: string | undefined
  /** Docker image of the warm sidecar, once one has started. */
  readonly image: string | undefined
  /** Resolves the image the sidecar would start for this context; null when it cannot be derived. */
  resolveImage(ctx: { cwd: string }): string | null
  /** Ensures a ready sidecar exists and returns its WebSocket endpoint. */
  ensure(ctx: { cwd: string }, onProgress: (phase: string) => void): Promise<string>
  /** Best-effort removal of the warm container. */
  dispose(): void
}

export interface BrowserSidecarOptions {
  docker?: DockerOptions
  exec?: DockerExec
  getPlaywrightVersion?: (cwd: string) => string | null
  containerName?: string
  /** Container-side `run-server` port; the host publish is always ephemeral. */
  port?: number
  readinessTimeoutMs?: number
  readinessIntervalMs?: number
  /** Injectable CLI-existence seam; defaults to the host filesystem. */
  fileExists?: (path: string) => boolean
  /** Injectable readiness seam; defaults to a TCP connect on the published port. */
  probeTcp?: (host: string, port: number) => Promise<boolean>
  sleep?: (ms: number) => Promise<void>
  /** Server-side debug channel: preparation phases, container details, and retention. */
  debug?: DebugLogger
  /** Terminal sink for unconditional failure evidence; defaults to console.error. */
  log?: (message: string) => void
}

/** Module-private: resolved seams and configuration shared by one sidecar manager. */
interface SidecarDeps {
  exec: DockerExec
  containerName: string
  containerPort: number
  docker?: DockerOptions
  getVersion: (cwd: string) => string | null
  fileExists: (path: string) => boolean
  probeTcp: (host: string, port: number) => Promise<boolean>
  sleep: (ms: number) => Promise<void>
  readinessTimeoutMs: number
  readinessIntervalMs: number
  debug?: DebugLogger
  log: (message: string) => void
}

function resolveSidecarDeps(options: BrowserSidecarOptions): SidecarDeps {
  return {
    exec: options.exec ?? createDockerExec(),
    containerName: options.containerName ?? `crvy-rprtr-browser-${process.pid}`,
    containerPort: options.port ?? BROWSER_SIDECAR_PORT,
    docker: options.docker,
    getVersion: options.getPlaywrightVersion ?? resolvePlaywrightVersion,
    fileExists: options.fileExists ?? existsSync,
    probeTcp: options.probeTcp ?? tcpProbe,
    sleep:
      options.sleep ??
      ((ms: number): Promise<void> =>
        new Promise((resolve) => {
          setTimeout(resolve, ms)
        })),
    readinessTimeoutMs: options.readinessTimeoutMs ?? READINESS_TIMEOUT_MS,
    readinessIntervalMs: options.readinessIntervalMs ?? READINESS_INTERVAL_MS,
    debug: options.debug,
    log: options.log ?? console.error,
  }
}

/** Resolves the image tag, pulling it when missing and emitting the `pulling` progress phase. */
async function ensureSidecarImage(
  deps: SidecarDeps,
  version: string | null,
  onProgress: (phase: string) => void,
): Promise<string> {
  const image = resolveDockerImage({ image: deps.docker?.image, version })
  if (image === null) {
    throw new Error('Could not resolve the installed playwright version; set docker.image explicitly.')
  }
  if (!(await isDockerImagePresent(deps.exec, image))) {
    onProgress('pulling')
    await runPhase(deps.debug, 'image-pull', async () => {
      if (!(await pullDockerImage(deps.exec, image))) {
        throw new Error(`Failed to pull docker image: ${image}`)
      }
    })
  }
  return image
}

interface StartedSidecar {
  endpoint: string
  port: number
}

/** Binds the sidecar's resolved seams into the evidence recorder's shape. */
function evidenceDeps(deps: SidecarDeps): SidecarEvidenceDeps {
  return {
    exec: deps.exec,
    containerName: deps.containerName,
    debug: deps.debug,
    log: deps.log,
  }
}

/** Starts the detached container and resolves its ready loopback endpoint. */
async function startSidecar(
  deps: SidecarDeps,
  ctx: { cwd: string },
  image: string,
  version: string | null,
): Promise<StartedSidecar> {
  const command = resolveSidecarCommand({ cwd: ctx.cwd, version, fileExists: deps.fileExists })
  const runArgs = buildBrowserSidecarRunArgs({
    cwd: ctx.cwd,
    image,
    containerName: deps.containerName,
    command,
    port: deps.containerPort,
    docker: deps.docker,
    debug: deps.debug,
    fileExists: deps.fileExists,
  })
  const port = await runPhase(deps.debug, 'sidecar-start', async () => {
    await forceRemoveContainer(deps.exec, deps.containerName)
    const result = await deps.exec(runArgs)
    if (result.exitCode !== 0) {
      throw new Error(`Failed to start the browser sidecar: ${result.stderr.trim() || `exit code ${result.exitCode}`}`)
    }
    const publishedPort = await resolvePublishedPort(deps.exec, deps.containerName, deps.containerPort)
    if (publishedPort === null) {
      await recordSidecarFailure(evidenceDeps(deps), image)
      if (deps.debug?.enabled !== true) await forceRemoveContainer(deps.exec, deps.containerName)
      throw new DockerUnavailableError()
    }
    return publishedPort
  })
  await runPhase(deps.debug, 'readiness', async () => {
    const ready = await waitForEndpoint({
      probe: () => deps.probeTcp('127.0.0.1', port),
      timeoutMs: deps.readinessTimeoutMs,
      intervalMs: deps.readinessIntervalMs,
      sleep: deps.sleep,
    })
    if (!ready) {
      await recordSidecarFailure(evidenceDeps(deps), image)
      if (deps.debug?.enabled !== true) await forceRemoveContainer(deps.exec, deps.containerName)
      throw new DockerUnavailableError()
    }
  })
  return { endpoint: `ws://127.0.0.1:${port}/`, port }
}

/**
 * Manages the warm `playwright run-server` sidecar (D1/D3): probe → pull →
 * start → TCP readiness, reused across runs and removed on dispose. The
 * container runs detached with an ephemeral loopback publish; readiness is a
 * plain TCP probe because the endpoint is served on the root path.
 */
export function createBrowserSidecar(options: BrowserSidecarOptions = {}): BrowserSidecar {
  const deps = resolveSidecarDeps(options)
  let endpoint: string | undefined
  let publishedPort: number | undefined
  let startedImage: string | undefined

  return {
    get endpoint(): string | undefined {
      return endpoint
    },
    get image(): string | undefined {
      return startedImage
    },
    resolveImage(ctx): string | null {
      return resolveDockerImage({ image: deps.docker?.image, version: deps.getVersion(ctx.cwd) })
    },
    async ensure(ctx, onProgress): Promise<string> {
      const daemonUp = await runPhase(deps.debug, 'daemon-probe', () => probeDockerDaemon(deps.exec))
      if (!daemonUp) throw new DockerUnavailableError()
      if (endpoint !== undefined && publishedPort !== undefined && (await deps.probeTcp('127.0.0.1', publishedPort))) {
        return endpoint
      }
      endpoint = undefined
      publishedPort = undefined
      const version = deps.getVersion(ctx.cwd)
      const image = await ensureSidecarImage(deps, version, onProgress)
      onProgress('starting-sidecar')
      const started = await startSidecar(deps, ctx, image, version)
      endpoint = started.endpoint
      publishedPort = started.port
      startedImage = image
      return started.endpoint
    },
    dispose(): void {
      endpoint = undefined
      publishedPort = undefined
      startedImage = undefined
      void forceRemoveContainer(deps.exec, deps.containerName)
    },
  }
}
