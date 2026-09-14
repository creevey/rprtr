/**
 * Host env forwarding for docker run mode. Never propagated into the container:
 * host-specific or launcher-pinned values. Upper-case, matched case-insensitively —
 * Windows env-var casing is nondeterministic (`Path` vs `PATH`).
 */
const ENV_DENYLIST = new Set([
  'CI',
  'PLAYWRIGHT_BROWSERS_PATH',
  'CRVY_RPRTR_SERVER_URL',
  'CRVY_RPRTR_PORTABLE_ARTIFACTS',
  'TZ',
  // The container must use its own home: a forwarded host HOME makes NSS (browser cert
  // store init) and npm resolve their state under it, and a Windows-style value like
  // `C:\Users\dev` is a *relative* path on Linux, so those tools would create a literal
  // `C:\Users\dev/.local/share/pki/nssdb` tree under the container CWD — i.e. inside the
  // bind-mounted project.
  'HOME',
  'NPM_CONFIG_CACHE',
  'LANG',
  'LC_ALL',
  'PLAYWRIGHT_HTML_OPEN',
  'PATH',
  // Host paths that do not exist in the container: fontconfig resolves them to nothing and
  // the browser ends up with no font directories at all (blank text). The container gets its
  // AA from the mounted drop-in instead.
  'FONTCONFIG_FILE',
  'FONTCONFIG_PATH',
])

/** Windows host env noise: host paths/separators a Linux container can't use, or host-platform markers (`OS`, `PROCESSOR_ARCHITECTURE`) that mislead in-container platform detection. */
const WINDOWS_ENV_NOISE = new Set(
  'SYSTEMROOT COMSPEC WINDIR PATHEXT OS PROGRAMFILES PROGRAMFILES(X86) PROGRAMW6432 PROGRAMDATA ALLUSERSPROFILE PUBLIC APPDATA LOCALAPPDATA TEMP TMP USERPROFILE HOMEDRIVE HOMEPATH USERNAME PSMODULEPATH DRIVERDATA NUMBER_OF_PROCESSORS PROCESSOR_ARCHITECTURE PROCESSOR_LEVEL PROCESSOR_REVISION'.split(
    ' ',
  ),
)

/**
 * Windows absolute path (drive letter or UNC). On a win32 host, any env var carrying such a
 * value is host noise: the path cannot exist in the container, and if a Linux tool treats it
 * as a relative POSIX path it materializes a literal `C:\...` tree under the container CWD —
 * into the mounted project. Catches unenumerable cases like `npm_config_cache` or `BUN_INSTALL`.
 */
const WINDOWS_PATH_VALUE = /^(?:[A-Za-z]:[\\/]|\\\\)/

/**
 * Names of `env` entries to forward into the container as name-only `-e NAME` flags.
 * Filters the denylist, Windows noise vars, undefined values, and — on win32 hosts —
 * any var whose value is a Windows absolute path.
 */
export function collectForwardedEnvNames(env: Record<string, string | undefined>, platform: NodeJS.Platform): string[] {
  const names: string[] = []
  for (const [key, value] of Object.entries(env)) {
    const upper = key.toUpperCase()
    if (ENV_DENYLIST.has(upper) || WINDOWS_ENV_NOISE.has(upper) || value === undefined) continue
    if (platform === 'win32' && WINDOWS_PATH_VALUE.test(value)) continue
    names.push(key)
  }
  return names
}
