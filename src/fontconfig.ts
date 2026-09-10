import { existsSync, mkdirSync, renameSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

/**
 * Fontconfig rule that forces grayscale text antialiasing for every font.
 *
 * `target="font"` is load-bearing: Ubuntu's own `10-sub-pixel-rgb.conf` edits `rgba` at
 * `target="pattern"` with `mode="append"`, and a pattern-level assign of ours does not
 * override it — verified in `mcr.microsoft.com/playwright:*-noble`.
 */
const GRAYSCALE_MATCH = `  <match target="font">
    <edit name="rgba" mode="assign"><const>none</const></edit>
  </match>`

const HEADER = `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">
<!-- Written by crvy-rprtr: pins grayscale text antialiasing for screenshot determinism. -->`

/**
 * Drop-in form, for `conf.d`: the rule alone, with the surrounding config supplied by the
 * distro. Docker run mode mounts this at {@link CONTAINER_FONTCONFIG_PATH}.
 */
export const GRAYSCALE_FONTCONFIG_XML = `${HEADER}
<fontconfig>
${GRAYSCALE_MATCH}
</fontconfig>
`

/**
 * Root-config form, for `FONTCONFIG_FILE`: the same rule, plus an include of the system
 * config it replaces. The include is not optional — `FONTCONFIG_FILE` replaces the root
 * config outright, and a root config with no font directories leaves the browser with no
 * fonts at all (verified: a page of text rendered completely blank, total ink 0).
 */
export function grayscaleRootFontconfigXml(systemConfigPath: string): string {
  return `${HEADER}
<fontconfig>
  <include ignore_missing="no">${escapeXml(systemConfigPath)}</include>
${GRAYSCALE_MATCH}
</fontconfig>
`
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Where a distro keeps the root config that `FONTCONFIG_FILE` would otherwise replace. */
const SYSTEM_FONTCONFIG_PATHS = ['/etc/fonts/fonts.conf', '/usr/local/etc/fonts/fonts.conf']

/** Generated root config; stable path so repeated runs reuse one file. */
export function rootFontconfigPath(): string {
  return join(tmpdir(), 'crvy-rprtr', 'fonts.conf')
}

/**
 * The root config our generated one must include: the caller's own `FONTCONFIG_FILE` /
 * `FONTCONFIG_PATH` when they set one (their rules survive, ours are appended after), else the
 * distro default. Returns null when nothing exists to include — the caller must then leave the
 * environment alone rather than break font lookup.
 */
export function resolveSystemFontconfig(
  env: Record<string, string | undefined> = process.env,
  exists: (path: string) => boolean = existsSync,
): string | null {
  const ours = rootFontconfigPath()
  const candidates = [
    env.FONTCONFIG_FILE,
    env.FONTCONFIG_PATH === undefined ? undefined : join(env.FONTCONFIG_PATH, 'fonts.conf'),
    ...SYSTEM_FONTCONFIG_PATHS,
  ]
  for (const candidate of candidates) {
    // Skipping our own file keeps a re-entrant call (nested run, re-exported env) from
    // generating a config that includes itself.
    if (candidate === undefined || candidate === ours) continue
    if (exists(candidate)) return candidate
  }
  return null
}

/** Writes the generated root config and returns its path. Rename keeps concurrent Playwright workers from reading a half-written file. */
export function ensureRootFontconfig(systemConfigPath: string): string {
  const path = rootFontconfigPath()
  mkdirSync(join(tmpdir(), 'crvy-rprtr'), { recursive: true })
  const staging = `${path}.${process.pid}.tmp`
  writeFileSync(staging, grayscaleRootFontconfigXml(systemConfigPath), 'utf8')
  renameSync(staging, path)
  return path
}

export interface GrayscaleFontconfigEnvOptions {
  /** Injectable seams for tests; default to the real platform and filesystem. */
  platform?: NodeJS.Platform
  exists?: (path: string) => boolean
  writeConfig?: (systemConfigPath: string) => string
}

/**
 * The `FONTCONFIG_FILE` override that pins grayscale AA for **every** browser that reads
 * fontconfig, or null when it does not apply.
 *
 * Why the environment and not `--disable-lcd-text`: browser args reach Chromium only, and
 * Firefox rejects unknown flags. The env var reaches whatever binary Playwright launches,
 * including a system Chromium passed via `executablePath`. Verified byte-identical to
 * `--disable-lcd-text` in `mcr.microsoft.com/playwright:v1.59.0-noble`.
 *
 * Null on non-Linux (macOS has had no subpixel AA since Mojave, Windows uses DirectWrite) and
 * when no system config exists to include — see {@link grayscaleRootFontconfigXml}.
 */
export function grayscaleFontconfigEnv(
  baseEnv: Record<string, string | undefined> = process.env,
  options: GrayscaleFontconfigEnvOptions = {},
): Record<string, string> | null {
  if ((options.platform ?? process.platform) !== 'linux') return null
  const systemConfig = resolveSystemFontconfig(baseEnv, options.exists)
  if (systemConfig === null) return null
  return { FONTCONFIG_FILE: (options.writeConfig ?? ensureRootFontconfig)(systemConfig) }
}
