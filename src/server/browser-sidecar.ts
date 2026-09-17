import { existsSync, readFileSync } from 'node:fs'
import { connect } from 'node:net'

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

/** Module-private: bound for a single readiness TCP connect before counting it as failed. */
const READINESS_CONNECT_TIMEOUT_MS = 1000

const READINESS_TIMEOUT_MS = 15000
const READINESS_INTERVAL_MS = 250

function tcpProbe(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port })
    const finish = (ok: boolean): void => {
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(READINESS_CONNECT_TIMEOUT_MS, () => {
      finish(false)
    })
    socket.once('connect', () => {
      finish(true)
    })
    socket.once('error', () => {
      finish(false)
    })
  })
}

/** Resolves the host port docker published for the sidecar's container port. */
async function resolvePublishedPort(
  exec: DockerExec,
  containerName: string,
  containerPort: number,
): Promise<number | null> {
  const result = await exec(['port', containerName, String(containerPort)])
  if (result.exitCode !== 0) return null
  for (const line of result.stdout.split('\n')) {
    const trimmed = line.trim()
    const index = trimmed.lastIndexOf(':')
    if (index === -1) continue
    const port = Number(trimmed.slice(index + 1))
    if (Number.isInteger(port) && port > 0 && port <= 65535) return port
  }
  return null
}

/** Probes until the endpoint answers or the timeout elapses; injectable sleep keeps tests instant. */
function waitForEndpoint(input: {
  probe: () => Promise<boolean>
  timeoutMs: number
  intervalMs: number
  sleep: (ms: number) => Promise<void>
}): Promise<boolean> {
  const attempt = async (waited: number): Promise<boolean> => {
    if (await input.probe()) return true
    if (waited >= input.timeoutMs) return false
    await input.sleep(input.intervalMs)
    return attempt(waited + input.intervalMs)
  }
  return attempt(0)
}

export interface BrowserSidecar {
  /** Endpoint of the warm sidecar, if one is currently ready. */
  readonly endpoint: string | undefined
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
    if (!(await pullDockerImage(deps.exec, image))) {
      throw new Error(`Failed to pull docker image: ${image}`)
    }
  }
  return image
}

interface StartedSidecar {
  endpoint: string
  port: number
}

/** Starts the detached container and resolves its ready loopback endpoint. */
async function startSidecar(
  deps: SidecarDeps,
  ctx: { cwd: string },
  image: string,
  version: string | null,
): Promise<StartedSidecar> {
  const command = resolveSidecarCommand({ cwd: ctx.cwd, version, fileExists: deps.fileExists })
  await forceRemoveContainer(deps.exec, deps.containerName)
  const result = await deps.exec(
    buildBrowserSidecarRunArgs({
      cwd: ctx.cwd,
      image,
      containerName: deps.containerName,
      command,
      port: deps.containerPort,
      docker: deps.docker,
    }),
  )
  if (result.exitCode !== 0) {
    throw new Error(`Failed to start the browser sidecar: ${result.stderr.trim() || `exit code ${result.exitCode}`}`)
  }
  const port = await resolvePublishedPort(deps.exec, deps.containerName, deps.containerPort)
  if (port === null) {
    await forceRemoveContainer(deps.exec, deps.containerName)
    throw new DockerUnavailableError()
  }
  const ready = await waitForEndpoint({
    probe: () => deps.probeTcp('127.0.0.1', port),
    timeoutMs: deps.readinessTimeoutMs,
    intervalMs: deps.readinessIntervalMs,
    sleep: deps.sleep,
  })
  if (!ready) {
    await forceRemoveContainer(deps.exec, deps.containerName)
    throw new DockerUnavailableError()
  }
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

  return {
    get endpoint(): string | undefined {
      return endpoint
    },
    async ensure(ctx, onProgress): Promise<string> {
      if (!(await probeDockerDaemon(deps.exec))) throw new DockerUnavailableError()
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
      return started.endpoint
    },
    dispose(): void {
      endpoint = undefined
      publishedPort = undefined
      void forceRemoveContainer(deps.exec, deps.containerName)
    },
  }
}
