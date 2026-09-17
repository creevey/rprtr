import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { collectForwardedEnvNames } from './docker-env.ts'
import { DOCKER_WORK_DIR, type DockerOptions } from './docker-launcher.ts'
import { rewritePlaywrightArgs, type Warn } from './docker-support.ts'
import { CONTAINER_FONTCONFIG_PATH, ensureGrayscaleFontconfig } from './fontconfig.ts'
import type { RunContext } from './run-controller.ts'

/** Module-private: only the arg vector built here uses it. */
const DOCKER_HOST_GATEWAY = 'host.docker.internal'

/** Module-private: local CLI candidates in resolution order, mirroring resolvePlaywrightVersion. */
const PLAYWRIGHT_CLI_SEGMENTS = [
  ['node_modules', 'playwright', 'cli.js'],
  ['node_modules', '@playwright', 'test', 'cli.js'],
] as const

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
}

/**
 * Docker run vector for the warm browser sidecar (D3): detached, auto-removed,
 * loopback-only ephemeral publish, read-only project mount, and the same
 * fontconfig/locale pinning as Playwright docker mode.
 */
export function buildBrowserSidecarRunArgs(input: BrowserSidecarArgsInput): string[] {
  const args = [
    'run',
    '-d',
    '--rm',
    '--init',
    '--ipc=host',
    '--name',
    input.containerName,
    '-p',
    `127.0.0.1::${input.port}`,
  ]
  if (input.docker?.platform !== undefined) {
    args.push('--platform', input.docker.platform)
  }
  if (input.docker?.fontRendering !== 'inherit') {
    args.push('-v', `${ensureGrayscaleFontconfig()}:${CONTAINER_FONTCONFIG_PATH}:ro`)
  }
  args.push('-v', `${input.cwd}:${DOCKER_WORK_DIR}:ro`)
  args.push('-e', 'TZ=UTC', '-e', 'LANG=C.UTF-8', '-e', 'LC_ALL=C.UTF-8')
  args.push(input.image, ...input.command, 'run-server', '--port', String(input.port), '--host', '0.0.0.0')
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
}

export function buildDockerRunArgs(ctx: RunContext, playwrightArgs: string[], deps: DockerRunArgsDeps): string[] {
  const { args: rewrittenArgs, bindMounts } = rewritePlaywrightArgs(playwrightArgs, ctx, deps.workDir, deps.warn)
  const args = [
    'run',
    '--rm',
    '--init',
    '--name',
    deps.containerName,
    '--add-host',
    `${DOCKER_HOST_GATEWAY}:host-gateway`,
    '--ipc=host',
  ]
  if (deps.docker?.platform !== undefined) {
    args.push('--platform', deps.docker.platform)
  }
  args.push('-v', `${ctx.cwd}:${deps.workDir}:rw`, '-w', deps.workDir)
  for (const mount of bindMounts) {
    args.push('-v', mount)
  }
  args.push('-e', `CRVY_RPRTR_SERVER_URL=ws://${DOCKER_HOST_GATEWAY}:${deps.port}`)
  args.push('-e', `CRVY_RPRTR_DOCKER_IMAGE=${deps.image}`)
  args.push('-e', 'CRVY_RPRTR_PORTABLE_ARTIFACTS=1', '-e', 'TZ=UTC', '-e', 'LANG=C.UTF-8', '-e', 'LC_ALL=C.UTF-8')
  args.push('-e', 'PLAYWRIGHT_HTML_OPEN=never')
  if (deps.docker?.fontRendering !== 'inherit') {
    args.push('-v', `${ensureGrayscaleFontconfig()}:${CONTAINER_FONTCONFIG_PATH}:ro`)
  }
  for (const key of collectForwardedEnvNames(deps.env, deps.platform)) {
    args.push('-e', key)
  }
  if (deps.docker?.extraArgs !== undefined) args.push(...deps.docker.extraArgs)
  args.push(deps.image, ...deps.command, 'playwright', ...rewrittenArgs)
  return args
}

export function stripCi(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(env)) {
    if (key === 'CI') continue
    out[key] = value
  }
  return out
}
