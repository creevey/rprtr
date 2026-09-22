import { resolveCommand } from 'package-manager-detector/commands'
import { getUserAgent } from 'package-manager-detector/detect'

import { DOCKER_HOST_GATEWAY_ENV, DOCKER_MODE_ENV } from '../docker-contract.ts'
import { grayscaleFontconfigEnv, type GrayscaleFontconfigEnvOptions } from '../fontconfig.ts'
import type { FontRendering } from '../rendering.ts'
import type { RunContext } from './run-controller.ts'

export interface LaunchSpec {
  cmd: string
  args: string[]
  env: Record<string, string | undefined>
}

export interface LaunchParams {
  ctx: RunContext
  playwrightArgs: string[]
}

export interface RunLauncher {
  readonly mode: 'local' | 'docker'
  /** false once a docker probe/pull has failed; undefined for local or unprobed. */
  readonly available?: boolean
  /** Docker: probe the daemon, resolve image and container command, pull if missing. */
  prepare?(params: { ctx: RunContext; onProgress: (phase: string) => void }): Promise<void>
  /**
   * Docker: per-run host-service divergence diagnostic, based on the config summary
   * cached by `prepare` and probed live on every call. Absent for local runs.
   */
  diagnose?(): Promise<string[]>
  launch(params: LaunchParams): LaunchSpec
  /** Docker: best-effort removal of the named container on the SIGKILL path. */
  onForceKill?(): void
}

/**
 * Resolves the launch command for a local runner binary (`playwright`,
 * `vitest`, …) through the project's package manager.
 * `cwd` is reserved for future cwd-based detection (`package-manager-detector`'s
 * `detect` is async in v1.x and cannot run in the synchronous `start()` path),
 * so today detection uses the synchronous `getUserAgent()`, matching Creevey's
 * spawn pattern. Falls back to `npx` when no agent is detectable.
 */
export function resolveLocalCommand(name: string, args: string[]): { cmd: string; args: string[] } {
  const agent = getUserAgent()
  const resolved = agent === null ? null : resolveCommand(agent, 'execute-local', [name, ...args])
  if (resolved !== null) return { cmd: resolved.command, args: resolved.args }
  return { cmd: 'npx', args: [name, ...args] }
}

export function resolvePlaywrightLaunch(cwd: string, playwrightArgs: string[]): { cmd: string; args: string[] } {
  return resolveLocalCommand('playwright', playwrightArgs)
}

export interface SpawnEnvOptions extends GrayscaleFontconfigEnvOptions {
  /**
   * Text antialiasing for the browsers this run launches. `'grayscale'` (default) exports a
   * `FONTCONFIG_FILE` override, which Playwright's browsers inherit through the test process,
   * so a local run matches docker run mode without the project touching `launchOptions`;
   * `'inherit'` leaves the environment's own rendering in place.
   */
  fontRendering?: FontRendering
}

/**
 * Never propagated from the host into a local (or sidecar-backed Vitest) spawn:
 * `CI` makes Playwright behave differently, and the docker gateway contract
 * describes a container this process is not running in.
 */
const LOCAL_ENV_DENYLIST = new Set(['CI', DOCKER_MODE_ENV, DOCKER_HOST_GATEWAY_ENV])

export function buildSpawnEnv(
  port: number,
  baseEnv: Record<string, string | undefined> = process.env,
  options: SpawnEnvOptions = {},
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(baseEnv)) {
    if (LOCAL_ENV_DENYLIST.has(key.toUpperCase())) continue
    env[key] = value
  }
  env.CRVY_RPRTR_SERVER_URL = `ws://localhost:${port}`
  env.PLAYWRIGHT_HTML_OPEN = 'never'
  const { fontRendering = 'grayscale', ...fontconfigOptions } = options
  if (fontRendering !== 'inherit') {
    Object.assign(env, grayscaleFontconfigEnv(baseEnv, fontconfigOptions) ?? {})
  }
  return env
}

export interface LocalLauncherOptions extends SpawnEnvOptions {
  port: number
  resolveLaunch?: (cwd: string, playwrightArgs: string[]) => { cmd: string; args: string[] }
  env?: Record<string, string | undefined>
}

export function createLocalLauncher(options: LocalLauncherOptions): RunLauncher {
  return {
    mode: 'local',
    launch({ ctx, playwrightArgs }: LaunchParams): LaunchSpec {
      // The default resolver picks the runner binary by kind; an injected
      // resolveLaunch stays fully responsible for the command shape.
      const resolve =
        options.resolveLaunch ??
        (ctx.runner === 'vitest'
          ? (cwd: string, args: string[]): { cmd: string; args: string[] } => resolveLocalCommand('vitest', args)
          : resolvePlaywrightLaunch)
      const { cmd, args } = resolve(ctx.cwd, playwrightArgs)
      const { port, resolveLaunch: _resolveLaunch, env: baseEnv, ...spawnEnvOptions } = options
      return { cmd, args, env: buildSpawnEnv(port, baseEnv, spawnEnvOptions) }
    },
  }
}
