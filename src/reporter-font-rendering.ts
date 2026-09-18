import type { GrayscaleFontconfigEnvOptions } from './fontconfig.ts'
import { applyGrayscaleFontRendering, type FontRenderingSkipReason } from './rendering.ts'
import { parseFontRendering } from './schemas.ts'

/** Seams the reporters share for pinning; all default to the real process. */
export interface FontRenderingSeams {
  /** The environment every worker forked later inherits. Defaults to `process.env`. */
  env?: Record<string, string | undefined>
  /** Where a skip is reported. Defaults to `console.log`. */
  log?: (message: string) => void
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
export function pinReporterFontRendering(options: { fontRendering?: unknown }, seams: FontRenderingSeams = {}): void {
  const fontRendering = parseFontRendering(options)
  const env = seams.env ?? process.env
  const fontconfig = seams.fontconfig ?? {}
  const result = applyGrayscaleFontRendering(env, { ...fontconfig, fontRendering })
  if (result.pinned) return

  const message = describeSkip(result.reason, fontconfig.platform ?? process.platform)
  if (message !== null) (seams.log ?? console.log)(message)
}
