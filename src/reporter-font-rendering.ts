import { rootFontconfigPath, type GrayscaleFontconfigEnvOptions } from './fontconfig.ts'
import { applyGrayscaleFontRendering, type FontRenderingSkipReason } from './rendering.ts'
import { parseFontRendering } from './schemas.ts'

/** Seams the reporters share for pinning; all default to the real process. */
export interface FontRenderingSeams {
  /** The environment every worker forked later inherits. Defaults to `process.env`. */
  env?: Record<string, string | undefined>
  /** Where a skip is reported. Defaults to `console.log`. */
  log?: (message: string) => void
  /** Where a replaced browser environment is reported. Defaults to `console.warn`. */
  warn?: (message: string) => void
  /** Platform and filesystem seams for the generated config. */
  fontconfig?: GrayscaleFontconfigEnvOptions
}

/**
 * A skip must never be silent: an unexplained no-op is exactly what let a
 * reporter-only run keep taking its antialiasing from the image. `already-pinned`
 * is the one exception — a crvy-rprtr run mode set the value, so there is nothing
 * for the consumer to act on.
 */
function describeSkip(reason: FontRenderingSkipReason, platform: NodeJS.Platform): string | null {
  switch (reason) {
    case 'already-pinned':
      return null
    case 'inherit':
      return "[CrvyRprtr] fontRendering: 'inherit' — leaving text antialiasing to the environment."
    case 'not-linux':
      return `[CrvyRprtr] Text rendering is not fontconfig-driven on ${platform}; leaving antialiasing alone.`
    case 'no-system-config':
      return '[CrvyRprtr] Found no system fontconfig to extend; leaving antialiasing alone rather than breaking font lookup.'
  }
}

/**
 * Pins grayscale antialiasing on the reporter's own process environment.
 *
 * Called from a reporter constructor, which runs strictly before any test worker
 * is forked; each worker snapshots the environment at spawn, and the browser it
 * launches reads that environment at launch. So one assignment here covers a
 * plain `playwright test` or `vitest run` with no config change.
 */
export function pinReporterFontRendering(
  options: { fontRendering?: unknown },
  seams: FontRenderingSeams = {},
): boolean {
  const fontRendering = parseFontRendering(options)
  const env = seams.env ?? process.env
  const fontconfig = seams.fontconfig ?? {}
  const result = applyGrayscaleFontRendering(env, { ...fontconfig, fontRendering })
  if (result.pinned) return true

  const message = describeSkip(result.reason, fontconfig.platform ?? process.platform)
  if (message !== null) (seams.log ?? console.log)(message)
  return false
}

/** The slice of a resolved Playwright config this check reads. It never mutates it. */
interface ConfigWithProjects {
  projects?: ReadonlyArray<{ name?: string; use?: { launchOptions?: { env?: Readonly<Record<string, unknown>> } } }>
}

/**
 * `launchOptions.env` replaces the browser's environment wholesale rather than
 * extending it, so it silently discards the `FONTCONFIG_FILE` the constructor
 * set. The reporter cannot fix this — it receives the resolved config read-only,
 * and a consumer may have set `env` for reasons of their own — so it warns once
 * and points at the helper that merges the pin back in.
 *
 * A project whose `env` already carries our generated config is the consumer
 * applying that helper, and is not reported.
 */
export function projectsReplacingBrowserEnv(config: ConfigWithProjects): string[] {
  const ours = rootFontconfigPath()
  return (config.projects ?? [])
    .filter((project) => {
      const env = project.use?.launchOptions?.env
      return env !== undefined && env.FONTCONFIG_FILE !== ours
    })
    .map((project, index) => (project.name === undefined || project.name === '' ? `#${index}` : project.name))
}

/** Warns once per run when a resolved config would drop the pin. No-op when nothing was pinned. */
export function warnOnReplacedBrowserEnv(config: ConfigWithProjects, pinned: boolean, seams: FontRenderingSeams): void {
  if (!pinned) return
  const affected = projectsReplacingBrowserEnv(config)
  if (affected.length === 0) return
  ;(seams.warn ?? console.warn)(
    `[CrvyRprtr] ${affected.join(', ')} set launchOptions.env, which replaces the browser environment and drops the ` +
      'grayscale antialiasing pin. Wrap those options in deterministicLaunchOptions() from @crvy/rprtr/rendering ' +
      'to merge it back in.',
  )
}
