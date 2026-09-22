import type { PinBrowser, ResolvedProjectPin } from '../browser-pins.ts'
import type { DockerConfigSummary } from './config-dump.ts'
import { diagnoseDockerHostServices, type HostServiceProbe } from './docker-host-services.ts'
import { assertDockerPinsSatisfied } from './docker-preflight.ts'
import { buildDockerRunArgs, stripCi } from './docker-run-args.ts'
import {
  createDockerExec,
  detectProjectAgent,
  DockerUnavailableError,
  forceRemoveContainer,
  isDockerImagePresent,
  probeDockerDaemon,
  pullDockerImage,
  resolveContainerCommand,
  resolveDockerImage,
  DEFAULT_CONTAINER_COMMAND,
  type DetectAgent,
  type DockerExec,
  type Warn,
} from './docker-support.ts'
import type { RunContext } from './run-controller.ts'
import { resolvePlaywrightVersion } from './run-controller.ts'
import type { LaunchParams, LaunchSpec, RunLauncher } from './run-launcher.ts'

export const DOCKER_WORK_DIR = '/work'

export interface DockerOptions {
  image?: string
  platform?: 'linux/amd64' | 'linux/arm64'
  command?: string[]
  extraArgs?: string[]
  /**
   * Text antialiasing inside the container. `'grayscale'` (default) mounts a fontconfig
   * drop-in that switches Chromium to grayscale AA, so screenshots do not depend on the
   * image's subpixel settings; `'inherit'` leaves the image as it is.
   *
   * Local run mode pins the same rendering through `FONTCONFIG_FILE`, and a consumer's own
   * CI, which runs Playwright directly, matches both with `deterministicLaunchOptions()` from
   * `@crvy/rprtr/rendering`. Baselines captured with subpixel AA have to be regenerated once
   * after the switch.
   */
  fontRendering?: 'grayscale' | 'inherit'
}

export interface DockerLauncherOptions {
  port: number
  docker?: DockerOptions
  getPlaywrightVersion?: (cwd: string) => string | null
  exec?: DockerExec
  detectAgent?: DetectAgent
  env?: Record<string, string | undefined>
  containerName?: string
  workDir?: string
  warn?: Warn
  /** Injectable host-platform seam for tests; defaults to process.platform. */
  platform?: NodeJS.Platform
  /** Injectable pin reader for tests; defaults to the dump-aware `playwright test --list` listing. */
  readProjectPins?: (cwd: string) => Promise<readonly ResolvedProjectPin[]>
  /** Injectable config summary reader for tests; defaults to the dump-aware preflight listing. */
  readConfigSummary?: (cwd: string) => Promise<DockerConfigSummary | null>
  /** Injectable host-service probe for the per-run diagnostic; defaults to real HTTP/TCP probes. */
  probeHostService?: Partial<HostServiceProbe>
  /** Injectable executable-path seam for tests; defaults to the installed browser types. */
  browserExecutablePaths?: Partial<Record<PinBrowser, string>>
}

export { DockerUnavailableError }

interface LauncherState {
  available: boolean | undefined
  prepared: Promise<void> | null
  image: string | null
  command: readonly string[]
  warnedWin32: boolean
  /** Config summary cached with the memoized prepare; the host probe runs per run request. */
  configSummary: DockerConfigSummary | null
}

interface PrepareDeps {
  docker?: DockerOptions
  getPlaywrightVersion: (cwd: string) => string | null
  detectAgent?: DetectAgent
  warn: Warn
  platform: NodeJS.Platform
  readProjectPins?: (cwd: string) => Promise<readonly ResolvedProjectPin[]>
  readConfigSummary?: (cwd: string) => Promise<DockerConfigSummary | null>
  browserExecutablePaths?: Partial<Record<PinBrowser, string>>
}

function defaultWarn(message: string): void {
  console.warn(`[crvy-rprtr] ${message}`)
}

async function detectAgentName(detect: DetectAgent | undefined, cwd: string): Promise<string | null> {
  const detected = await (detect ?? detectProjectAgent)(cwd)
  return detected?.name ?? null
}

async function prepareDocker(
  state: LauncherState,
  exec: DockerExec,
  ctx: RunContext,
  deps: PrepareDeps,
  onProgress: (phase: string) => void,
): Promise<void> {
  if (deps.platform === 'win32' && !state.warnedWin32) {
    state.warnedWin32 = true
    deps.warn(
      'Native Windows host detected: docker run mode is experimental on this platform. For CI-identical baselines, run crvy-rprtr from WSL2 with the project stored in the WSL filesystem.',
    )
  }
  if (!(await probeDockerDaemon(exec))) {
    state.available = false
    throw new DockerUnavailableError()
  }
  state.available = true

  const image = resolveDockerImage({ image: deps.docker?.image, version: deps.getPlaywrightVersion(ctx.cwd) })
  if (image === null) {
    throw new Error('Could not resolve the installed @playwright/test version; set docker.image explicitly.')
  }
  state.image = image

  state.configSummary = await assertDockerPinsSatisfied({
    cwd: ctx.cwd,
    image,
    warn: deps.warn,
    readProjectPins: deps.readProjectPins,
    readConfigSummary: deps.readConfigSummary,
    browserExecutablePaths: deps.browserExecutablePaths,
  })

  state.command = resolveContainerCommand({
    command: deps.docker?.command,
    hasCustomImage: deps.docker?.image !== undefined,
    detectedAgentName: deps.docker?.image === undefined ? 'npm' : await detectAgentName(deps.detectAgent, ctx.cwd),
    warn: deps.warn,
  })

  if (!(await isDockerImagePresent(exec, image))) {
    onProgress('pulling')
    if (!(await pullDockerImage(exec, image))) {
      throw new Error(`Failed to pull docker image: ${image}`)
    }
  }
}

interface LauncherDeps {
  exec: DockerExec
  workDir: string
  containerName: string
  baseEnv: Record<string, string | undefined>
  getVersion: (cwd: string) => string | null
  detectAgent: DetectAgent | undefined
  warn: Warn
  platform: NodeJS.Platform
  docker?: DockerOptions
  port: number
  readProjectPins?: (cwd: string) => Promise<readonly ResolvedProjectPin[]>
  readConfigSummary?: (cwd: string) => Promise<DockerConfigSummary | null>
  probeHostService?: Partial<HostServiceProbe>
  browserExecutablePaths?: Partial<Record<PinBrowser, string>>
}

function createState(docker?: DockerOptions): LauncherState {
  return {
    available: undefined,
    prepared: null,
    image: null,
    command: docker?.command ?? DEFAULT_CONTAINER_COMMAND,
    warnedWin32: false,
    configSummary: null,
  }
}

function prepareLauncher(
  state: LauncherState,
  deps: LauncherDeps,
  ctx: RunContext,
  onProgress: (phase: string) => void,
): Promise<void> {
  state.prepared ??= prepareDocker(
    state,
    deps.exec,
    ctx,
    {
      docker: deps.docker,
      getPlaywrightVersion: deps.getVersion,
      detectAgent: deps.detectAgent,
      warn: deps.warn,
      platform: deps.platform,
      readProjectPins: deps.readProjectPins,
      readConfigSummary: deps.readConfigSummary,
      browserExecutablePaths: deps.browserExecutablePaths,
    },
    onProgress,
  ).catch((error: unknown) => {
    // Reset so a later run re-probes after the user fixes the problem.
    state.prepared = null
    state.warnedWin32 = false
    state.configSummary = null
    throw error
  })
  return state.prepared
}

function buildLauncher(state: LauncherState, deps: LauncherDeps): RunLauncher {
  return {
    mode: 'docker',
    get available(): boolean | undefined {
      return state.available
    },
    prepare({ ctx, onProgress }): Promise<void> {
      return prepareLauncher(state, deps, ctx, onProgress)
    },
    diagnose(): Promise<string[]> {
      return diagnoseDockerHostServices({ config: state.configSummary, probe: deps.probeHostService })
    },
    launch({ ctx, playwrightArgs }: LaunchParams): LaunchSpec {
      const image = state.image ?? resolveDockerImage({ image: deps.docker?.image, version: deps.getVersion(ctx.cwd) })
      if (image === null) {
        throw new Error('Could not resolve the docker image; run prepare() first or set docker.image.')
      }
      const args = buildDockerRunArgs(ctx, playwrightArgs, {
        docker: deps.docker,
        workDir: deps.workDir,
        containerName: deps.containerName,
        port: deps.port,
        env: deps.baseEnv,
        image,
        command: state.command,
        warn: deps.warn,
        platform: deps.platform,
      })
      return { cmd: 'docker', args, env: stripCi(deps.baseEnv) }
    },
    onForceKill(): void {
      void forceRemoveContainer(deps.exec, deps.containerName)
    },
  }
}

export function createDockerLauncher(options: DockerLauncherOptions): RunLauncher {
  return buildLauncher(createState(options.docker), {
    exec: options.exec ?? createDockerExec(),
    workDir: options.workDir ?? DOCKER_WORK_DIR,
    containerName: options.containerName ?? `crvy-rprtr-run-${process.pid}`,
    baseEnv: options.env ?? process.env,
    getVersion: options.getPlaywrightVersion ?? resolvePlaywrightVersion,
    detectAgent: options.detectAgent,
    warn: options.warn ?? defaultWarn,
    platform: options.platform ?? process.platform,
    docker: options.docker,
    port: options.port,
    readProjectPins: options.readProjectPins,
    readConfigSummary: options.readConfigSummary,
    probeHostService: options.probeHostService,
    browserExecutablePaths: options.browserExecutablePaths,
  })
}
