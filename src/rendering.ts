import type { LaunchOptions } from '@playwright/test'

import { grayscaleFontconfigEnv, rootFontconfigPath, type GrayscaleFontconfigEnvOptions } from './fontconfig.ts'

/**
 * Chromium switch that turns off subpixel (LCD RGB) text antialiasing and falls back to
 * grayscale AA.
 *
 * Why it is needed even when every run shares one docker image: on Linux Chromium takes the
 * text AA mode from **fontconfig**, so any second browser with a different fontconfig — a
 * system Chromium via `executablePath`, a distro package, an agent-provided binary — renders
 * the same page with colored fringes on every glyph. Glyph metrics stay identical, so the
 * diff is invisible to the eye but fatal to the comparator: ~3% of a text-heavy screenshot
 * differs, with channel deltas up to 100. Baselines then flip back and forth between the two
 * environments, one "update baselines" commit at a time.
 *
 * The same rendering is what crvy-rprtr forces in its own run modes (there through
 * fontconfig, since a reporter cannot pass browser args); the mechanisms were verified to
 * produce byte-identical screenshots.
 */
export const DISABLE_LCD_TEXT_ARG = '--disable-lcd-text'

/** Chromium args that pin text rasterization so it does not depend on the environment. */
export const DETERMINISTIC_CHROMIUM_ARGS: readonly string[] = [DISABLE_LCD_TEXT_ARG]

/** `'inherit'` gives the browser back whatever the environment renders by default. */
export type FontRendering = 'grayscale' | 'inherit'

export interface DeterministicLaunchOptions extends GrayscaleFontconfigEnvOptions {
  /** Default `'grayscale'`. `'inherit'` makes the helper a no-op. */
  fontRendering?: FontRendering
}

/** Why a run was left with the environment's own antialiasing. */
export type FontRenderingSkipReason = 'inherit' | 'not-linux' | 'no-system-config' | 'already-pinned'

export type FontRenderingResult = { pinned: true; path: string } | { pinned: false; reason: FontRenderingSkipReason }

/**
 * Pins grayscale text antialiasing on `env`, mutating it in place, or explains why it did
 * not. The one place that decides "pin or not, and why": the reporters call it on
 * `process.env` before any worker is forked, {@link deterministicLaunchOptions} calls it on
 * a copy destined for `launchOptions.env`, and both run modes reuse the same reasons — so
 * the four cannot drift apart.
 *
 * `already-pinned` is detected by comparing the incoming `FONTCONFIG_FILE` against our own
 * generated path: `resolveSystemFontconfig` skips that file to stay re-entrant, so its
 * presence is a reliable marker that a crvy-rprtr launcher set it.
 */
export function applyGrayscaleFontRendering(
  env: Record<string, string | undefined>,
  options: DeterministicLaunchOptions = {},
): FontRenderingResult {
  const { fontRendering = 'grayscale', ...envOptions } = options
  if (fontRendering === 'inherit') return { pinned: false, reason: 'inherit' }
  if ((envOptions.platform ?? process.platform) !== 'linux') return { pinned: false, reason: 'not-linux' }
  if (env.FONTCONFIG_FILE === rootFontconfigPath()) return { pinned: false, reason: 'already-pinned' }

  const fontconfig = grayscaleFontconfigEnv(env, envOptions)
  if (fontconfig === null) return { pinned: false, reason: 'no-system-config' }

  env.FONTCONFIG_FILE = fontconfig.FONTCONFIG_FILE
  return { pinned: true, path: fontconfig.FONTCONFIG_FILE }
}

/**
 * Merges {@link DETERMINISTIC_CHROMIUM_ARGS} into existing launch options, keeping the
 * caller's own args:
 *
 * ```ts
 * use: { launchOptions: deterministicChromiumLaunchOptions() }
 * ```
 *
 * Chromium-only by construction — Firefox exits on unknown command-line flags. Prefer
 * {@link deterministicLaunchOptions}, which pins the same rendering for every browser;
 * this one stays for configs that cannot set browser env vars.
 *
 * Switching an existing suite to it invalidates baselines that were captured with subpixel
 * AA — regenerate them once, in the same image, right after adding the option.
 */
export function deterministicChromiumLaunchOptions(base: LaunchOptions = {}): LaunchOptions {
  const args = base.args ?? []
  const missing = DETERMINISTIC_CHROMIUM_ARGS.filter((arg) => !args.includes(arg))
  return { ...base, args: [...args, ...missing] }
}

/**
 * Launch options that pin grayscale text antialiasing for **any** browser, by pointing the
 * browser process at a generated fontconfig root config:
 *
 * ```ts
 * use: { launchOptions: deterministicLaunchOptions() }
 * ```
 *
 * Equivalent to `--disable-lcd-text` for Chromium (verified byte-identical) and a no-op for
 * the Playwright builds of Firefox and WebKit, which never rasterize with subpixel AA — so a
 * multi-browser suite can apply it uniformly. Outside Linux it returns `base` unchanged.
 *
 * Baselines captured with subpixel AA have to be regenerated once after adding it. Opt out
 * with `{ fontRendering: 'inherit' }` when faithful desktop text matters more than
 * determinism.
 */
export function deterministicLaunchOptions(
  base: LaunchOptions = {},
  options: DeterministicLaunchOptions = {},
): LaunchOptions {
  // `env` replaces the browser's environment rather than extending it, so the inherited one
  // has to be spread back in; the caller's own entries win over ours except for the override.
  const baseEnv: Record<string, string | undefined> = { ...process.env, ...base.env }
  // Routing through the shared decision keeps this helper and the reporters from diverging.
  const result = applyGrayscaleFontRendering(baseEnv, options)
  if (!result.pinned) {
    // `already-pinned` means the environment the browser would inherit already
    // carries our config — nothing to do, unless the caller passed an `env` of
    // their own, which REPLACES that environment and would drop the pin.
    if (result.reason !== 'already-pinned' || base.env === undefined) return base
  }

  const env: NonNullable<LaunchOptions['env']> = {}
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value !== undefined) env[key] = value
  }
  return { ...base, env }
}
