import type { LaunchOptions } from '@playwright/test'

import { grayscaleFontconfigEnv, type GrayscaleFontconfigEnvOptions } from './fontconfig.ts'

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
  const { fontRendering = 'grayscale', ...envOptions } = options
  if (fontRendering === 'inherit') return base
  // `env` replaces the browser's environment rather than extending it, so the inherited one
  // has to be spread back in; the caller's own entries win over ours except for the override.
  const baseEnv = { ...process.env, ...base.env }
  const fontconfig = grayscaleFontconfigEnv(baseEnv, envOptions)
  if (fontconfig === null) return base
  const env: NonNullable<LaunchOptions['env']> = {}
  for (const [key, value] of Object.entries({ ...baseEnv, ...fontconfig })) {
    if (value !== undefined) env[key] = value
  }
  return { ...base, env }
}
