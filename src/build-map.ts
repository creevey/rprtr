import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import pLimit from 'p-limit'

import { matchesVersionPrefix } from './browser-pins.ts'
import { BrowserManifestSchema } from './playwright-install.ts'
import { PIN_BROWSERS, type PinBrowser } from './schemas/pins.ts'

export const PLAYWRIGHT_BUILDS_URL =
  'https://raw.githubusercontent.com/broverdev/playwright-builds/main/playwright-builds.json'

export const BUILD_MAP_TTL_MS = 24 * 60 * 60 * 1000

const PROBE_COUNT = 5
const PROBE_CONCURRENCY = 2

/** One Playwright release and the browser builds it ships (`"147.0.7727.15 (1217)"`). */
export interface PlaywrightBuildEntry {
  ver: string
  date?: string
  browsers: Partial<Record<PinBrowser, string>>
}

export interface BrowserBuild {
  version: string
  revision: string | null
}

export interface BuildMatch {
  playwrightVersion: string
  date?: string
  stable: boolean
  browser: BrowserBuild
}

export function isStablePlaywrightVersion(version: string): boolean {
  return /^\d+\.\d+\.\d+$/.test(version)
}

/** Parses `"147.0.7727.15 (1217)"` into version plus revision. */
export function parseBrowserBuild(value: string): BrowserBuild | null {
  const match = /^(\d+(?:\.\d+)*)\s*(?:\((\d+)\))?$/.exec(value.trim())
  if (match === null) return null
  const version = match[1]
  if (version === undefined) return null
  return { version, revision: match[2] ?? null }
}

function compareVersions(left: string, right: string): number {
  const [leftCore = '', leftPre] = left.split('-', 2)
  const [rightCore = '', rightPre] = right.split('-', 2)
  const leftSegments = leftCore.split('.').map(Number)
  const rightSegments = rightCore.split('.').map(Number)
  for (let i = 0; i < Math.max(leftSegments.length, rightSegments.length); i++) {
    const a = leftSegments[i] ?? 0
    const b = rightSegments[i] ?? 0
    if (a !== b) return a - b
  }
  if (leftPre === rightPre) return 0
  if (leftPre === undefined) return 1
  if (rightPre === undefined) return -1
  return leftPre < rightPre ? -1 : 1
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Validates a raw build-map document, dropping unusable entries. */
export function parseBuildMap(value: unknown): PlaywrightBuildEntry[] | null {
  if (!Array.isArray(value)) return null
  const entries: PlaywrightBuildEntry[] = []
  for (const raw of value) {
    if (!isRecord(raw) || typeof raw.ver !== 'string' || !isRecord(raw.browsers)) continue
    const browsers: Partial<Record<PinBrowser, string>> = {}
    for (const browser of PIN_BROWSERS) {
      const build = raw.browsers[browser]
      if (typeof build === 'string') browsers[browser] = build
    }
    entries.push({ ver: raw.ver, ...(typeof raw.date === 'string' ? { date: raw.date } : {}), browsers })
  }
  return entries.length === 0 ? null : entries.sort((a, b) => compareVersions(b.ver, a.ver))
}

/** Distinct matching builds for a prefix, newest Playwright release per build first. */
export function findBuilds(
  entries: readonly PlaywrightBuildEntry[],
  engine: PinBrowser,
  prefix: string,
  options: { includePrerelease?: boolean } = {},
): BuildMatch[] {
  const matches: BuildMatch[] = []
  const seen = new Set<string>()
  for (const entry of entries) {
    const stable = isStablePlaywrightVersion(entry.ver)
    if (options.includePrerelease !== true && !stable) continue
    const raw = entry.browsers[engine]
    if (raw === undefined) continue
    const browser = parseBrowserBuild(raw)
    if (browser === null || !matchesVersionPrefix(prefix, browser.version)) continue
    const key = `${browser.version}|${browser.revision ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    matches.push({
      playwrightVersion: entry.ver,
      ...(entry.date === undefined ? {} : { date: entry.date }),
      stable,
      browser,
    })
  }
  return matches
}

/** Closest browser majors per engine, for "nothing matches" diagnostics. */
export function nearestMajors(
  entries: readonly PlaywrightBuildEntry[],
  engine: PinBrowser,
  prefix: string,
  limit = 3,
): number[] {
  const target = Number.parseInt(prefix.split('.')[0] ?? '', 10)
  if (Number.isNaN(target)) return []
  const majors = new Set<number>()
  for (const entry of entries) {
    const raw = entry.browsers[engine]
    if (raw === undefined) continue
    const build = parseBrowserBuild(raw)
    const major = build === null ? Number.NaN : Number.parseInt(build.version.split('.')[0] ?? '', 10)
    if (!Number.isNaN(major)) majors.add(major)
  }
  return [...majors]
    .sort((left, right) => Math.abs(left - target) - Math.abs(right - target) || right - left)
    .slice(0, limit)
}

export function resolveBuildMapCachePath(): string {
  const base = process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache')
  return join(base, 'crvy-rprtr', 'playwright-builds.json')
}

interface CacheFile {
  fetchedAt: number
  entries: PlaywrightBuildEntry[]
}

export interface LoadBuildMapOptions {
  cachePath?: string
  refresh?: boolean
  now?: () => number
  ttlMs?: number
  fetchJson?: (url: string) => Promise<unknown>
}

export interface LoadedBuildMap {
  entries: PlaywrightBuildEntry[]
  source: 'cache' | 'network'
}

async function fetchJsonUrl(url: string): Promise<unknown> {
  try {
    const response = await fetch(url)
    if (!response.ok) return null
    return (await response.json()) as unknown
  } catch {
    return null
  }
}

async function readCache(cachePath: string): Promise<CacheFile | null> {
  try {
    const raw: unknown = JSON.parse(await readFile(cachePath, 'utf8'))
    if (!isRecord(raw) || typeof raw.fetchedAt !== 'number') return null
    const entries = parseBuildMap(raw.entries)
    return entries === null ? null : { fetchedAt: raw.fetchedAt, entries }
  } catch {
    return null
  }
}

async function writeCache(cachePath: string, cache: CacheFile): Promise<void> {
  try {
    await mkdir(dirname(cachePath), { recursive: true })
    await writeFile(cachePath, JSON.stringify({ fetchedAt: cache.fetchedAt, entries: cache.entries }))
  } catch {
    // Cache writes are best-effort; resolution still has the fetched map.
  }
}

/**
 * Loads the reverse build index from the user cache when fresh, otherwise from
 * the network. A stale cache is the offline fallback; null means no usable map.
 */
export async function loadBuildMap(options: LoadBuildMapOptions = {}): Promise<LoadedBuildMap | null> {
  const cachePath = options.cachePath ?? resolveBuildMapCachePath()
  const now = options.now ?? Date.now
  const ttlMs = options.ttlMs ?? BUILD_MAP_TTL_MS
  const cached = options.refresh === true ? null : await readCache(cachePath)
  if (cached !== null && now() - cached.fetchedAt < ttlMs) return { entries: cached.entries, source: 'cache' }

  const fetched = parseBuildMap(await (options.fetchJson ?? fetchJsonUrl)(PLAYWRIGHT_BUILDS_URL))
  if (fetched !== null) {
    await writeCache(cachePath, { fetchedAt: now(), entries: fetched })
    return { entries: fetched, source: 'network' }
  }
  return cached === null ? null : { entries: cached.entries, source: 'cache' }
}

/** Candidate stable releases to probe when the index has no matching prefix. */
export function candidateProbeVersions(baseVersion: string | null, count = PROBE_COUNT): string[] {
  if (baseVersion === null) return []
  const match = /^(\d+)\.(\d+)\.\d+/.exec(baseVersion.trim())
  if (match === null) return []
  const major = Number.parseInt(match[1] ?? '', 10)
  const minor = Number.parseInt(match[2] ?? '', 10)
  if (Number.isNaN(major) || Number.isNaN(minor)) return []
  return Array.from({ length: count }, (_, index) => `${major}.${minor + index + 1}.0`)
}

/** Probes jsDelivr for recent `playwright-core` releases' `browsers.json`. */
async function probeVersion(
  version: string,
  fetchJson: (url: string) => Promise<unknown>,
): Promise<PlaywrightBuildEntry | null> {
  const raw = await fetchJson(`https://cdn.jsdelivr.net/npm/playwright-core@${version}/browsers.json`)
  const manifest = BrowserManifestSchema.safeParse(raw)
  if (!manifest.success) return null
  const browsers: Partial<Record<PinBrowser, string>> = {}
  for (const browser of manifest.data.browsers) {
    if (browser.browserVersion === undefined) continue
    if (browser.name === 'chromium' || browser.name === 'firefox' || browser.name === 'webkit') {
      browsers[browser.name] = `${browser.browserVersion} (${browser.revision})`
    }
  }
  return Object.keys(browsers).length === 0 ? null : { ver: version, browsers }
}

export async function probeBuildMap(
  versions: readonly string[],
  fetchJson: (url: string) => Promise<unknown> = fetchJsonUrl,
): Promise<PlaywrightBuildEntry[]> {
  const limit = pLimit(PROBE_CONCURRENCY)
  const probed = await Promise.all(versions.map((version) => limit(() => probeVersion(version, fetchJson))))
  return probed.filter((entry): entry is PlaywrightBuildEntry => entry !== null)
}
