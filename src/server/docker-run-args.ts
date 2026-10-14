import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { DEBUG_ENV, formatRecord, type DebugLogger } from '../debug-log.ts'
import { DOCKER_HOST_GATEWAY, DOCKER_HOST_GATEWAY_ENV, DOCKER_MODE_ENV } from '../docker-contract.ts'
import { DOCKER_IMAGE_ENV } from '../docker-image.ts'
import { collectForwardedEnvNames } from './docker-env.ts'
import { DOCKER_WORK_DIR, type DockerOptions } from './docker-launcher.ts'
import { rewritePlaywrightArgs, type Warn } from './docker-support.ts'
import { CONTAINER_FONTCONFIG_PATH, ensureGrayscaleFontconfig } from './fontconfig.ts'
import type { RunContext } from './run-controller.ts'

/** Module-private: local CLI candidates in resolution order, mirroring resolvePlaywrightVersion. */
const PLAYWRIGHT_CLI_SEGMENTS = [
  ['node_modules', 'playwright', 'cli.js'],
  ['node_modules', '@playwright', 'test', 'cli.js'],
] as const

/** Label marking containers debug mode retains for inspection instead of auto-removing. */
export const DEBUG_CONTAINER_LABEL = 'crvy-rprtr.debug=1'

interface MountSummary {
  source: string
  exists: boolean
}

/** Extracts the host source path from a `source:target[:ro|rw]` bind-mount argument. */
function mountSource(mount: string): string {
  const body = mount.replace(/:(?:ro|rw)$/, '')
  const index = body.lastIndexOf(':')
  return index === -1 ? body : body.slice(0, index)
}

/**
 * Debug-only container-detail record: the resolved image, container name, the
 * pinned platform when one is set, and every bind-mount source with whether it
 * existed at launch — so a container that starts and exits immediately is
 * attributable without replaying the vector.
 */
function emitContainerRecord(
  debug: DebugLogger | undefined,
  input: { image: string; containerName: string; platform?: string; mounts: readonly MountSummary[] },
): void {
  if (debug?.enabled !== true) return
  const mounts = input.mounts.map((mount) => `${mount.source}:${mount.exists ? 'exists' : 'missing'}`).join(' ')
  debug.log(
    formatRecord('Docker', {
      event: 'container',
      image: input.image,
      container: input.containerName,
      platform: input.platform,
      mounts,
      inspect: `docker inspect ${input.containerName}`,
      logs: `docker logs ${input.containerName}`,
    }),
  )
}

/**
 * Picks the in-container run-server CLI from the mounted project: the local
 * Playwright CLI guarantees the image tag and CLI version match; a project
 * without a resolvable local CLI falls back to a version-pinned npx fetch.
 */
export function resolveSidecarCommand(input: {
  cwd: string
  version: string | null
  fileExists?: (path: string) => boolean
}): string[] {
  const exists = input.fileExists ?? existsSync
  for (const segments of PLAYWRIGHT_CLI_SEGMENTS) {
    if (exists(join(input.cwd, ...segments))) return ['node', join(DOCKER_WORK_DIR, ...segments)]
  }
  return ['npx', '-y', input.version === null ? 'playwright' : `playwright@${input.version}`]
}

export interface BrowserSidecarArgsInput {
  cwd: string
  image: string
  containerName: string
  command: readonly string[]
  port: number
  docker?: DockerOptions
  /** Server-side debug channel: container env, mount records, and retention. */
  debug?: DebugLogger
  /** Injectable mount-existence seam for the debug record; defaults to the host filesystem. */
  fileExists?: (path: string) => boolean
}

/**
 * Docker run vector for the warm browser sidecar (D3): detached, auto-removed,
 * loopback-only ephemeral publish, read-only project mount, and the same
 * fontconfig/locale pinning as Playwright docker mode.
 */
export function buildBrowserSidecarRunArgs(input: BrowserSidecarArgsInput): string[] {
  const retained = input.debug?.enabled === true
  const fileExists = input.fileExists ?? existsSync
  const mounts: MountSummary[] = []
  const args = ['run', '-d']
  if (!retained) args.push('--rm')
  args.push('--init', '--ipc=host', '--name', input.containerName, '-p', `127.0.0.1::${input.port}`)
  if (retained) args.push('--label', DEBUG_CONTAINER_LABEL)
  if (input.docker?.platform !== undefined) {
    args.push('--platform', input.docker.platform)
  }
  if (input.docker?.fontRendering !== 'inherit') {
    const source = ensureGrayscaleFontconfig()
    args.push('-v', `${source}:${CONTAINER_FONTCONFIG_PATH}:ro`)
    mounts.push({ source, exists: fileExists(source) })
  }
  args.push('-v', `${input.cwd}:${DOCKER_WORK_DIR}:ro`)
  mounts.push({ source: input.cwd, exists: fileExists(input.cwd) })
  args.push('-e', 'TZ=UTC', '-e', 'LANG=C.UTF-8', '-e', 'LC_ALL=C.UTF-8')
  if (input.debug?.enabled === true) args.push('-e', `${DEBUG_ENV}=1`)
  args.push(input.image, ...input.command, 'run-server', '--port', String(input.port), '--host', '0.0.0.0')
  emitContainerRecord(input.debug, {
    image: input.image,
    containerName: input.containerName,
    platform: input.docker?.platform,
    mounts,
  })
  return args
}

export interface DockerRunArgsDeps {
  docker?: DockerOptions
  workDir: string
  containerName: string
  port: number
  env: Record<string, string | undefined>
  image: string
  command: readonly string[]
  warn: Warn
  platform: NodeJS.Platform
  /** Server-side debug channel: container env, mount records, and retention. */
  debug?: DebugLogger
  /** Injectable mount-existence seam for the debug record; defaults to the host filesystem. */
  fileExists?: (path: string) => boolean
}

export function buildDockerRunArgs(ctx: RunContext, playwrightArgs: string[], deps: DockerRunArgsDeps): string[] {
  const { args: rewrittenArgs, bindMounts } = rewritePlaywrightArgs(playwrightArgs, ctx, deps.workDir, deps.warn)
  const retained = deps.debug?.enabled === true
  const fileExists = deps.fileExists ?? existsSync
  const mounts: MountSummary[] = [{ source: ctx.cwd, exists: fileExists(ctx.cwd) }]
  const args = ['run']
  if (!retained) args.push('--rm')
  args.push('--init', '--name', deps.containerName, '--add-host', `${DOCKER_HOST_GATEWAY}:host-gateway`, '--ipc=host')
  if (retained) args.push('--label', DEBUG_CONTAINER_LABEL)
  if (deps.docker?.platform !== undefined) {
    args.push('--platform', deps.docker.platform)
  }
  args.push('-v', `${ctx.cwd}:${deps.workDir}:rw`, '-w', deps.workDir)
  for (const mount of bindMounts) {
    args.push('-v', mount)
    mounts.push({ source: mountSource(mount), exists: fileExists(mountSource(mount)) })
  }
  args.push('-e', `CRVY_RPRTR_SERVER_URL=ws://${DOCKER_HOST_GATEWAY}:${deps.port}`)
  args.push('-e', `${DOCKER_IMAGE_ENV}=${deps.image}`)
  args.push('-e', 'CRVY_RPRTR_PORTABLE_ARTIFACTS=1')
  args.push('-e', `${DOCKER_MODE_ENV}=1`, '-e', `${DOCKER_HOST_GATEWAY_ENV}=${DOCKER_HOST_GATEWAY}`)
  args.push('-e', 'TZ=UTC', '-e', 'LANG=C.UTF-8', '-e', 'LC_ALL=C.UTF-8')
  args.push('-e', 'PLAYWRIGHT_HTML_OPEN=never')
  if (deps.debug?.enabled === true) args.push('-e', `${DEBUG_ENV}=1`)
  if (deps.docker?.fontRendering !== 'inherit') {
    const source = ensureGrayscaleFontconfig()
    args.push('-v', `${source}:${CONTAINER_FONTCONFIG_PATH}:ro`)
    mounts.push({ source, exists: fileExists(source) })
  }
  for (const key of collectForwardedEnvNames(deps.env, deps.platform)) {
    args.push('-e', key)
  }
  if (deps.docker?.extraArgs !== undefined) args.push(...deps.docker.extraArgs)
  args.push(deps.image, ...deps.command, 'playwright', ...rewrittenArgs)
  emitContainerRecord(deps.debug, {
    image: deps.image,
    containerName: deps.containerName,
    platform: deps.docker?.platform,
    mounts,
  })
  return args
}
