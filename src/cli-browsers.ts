import { parseArgs } from 'node:util'

import {
  defaultPinRemedy,
  readInstalledEnvironment,
  resolvePlaywrightVersion,
  type PinBrowser,
  type ProjectEnvironment,
  type ResolvedProjectPin,
} from './browser-pins.ts'
import {
  candidateProbeVersions,
  findBuilds,
  isStablePlaywrightVersion,
  loadBuildMap,
  nearestMajors,
  parseBrowserBuild,
  probeBuildMap,
  type BrowserBuild,
  type BuildMatch,
  type LoadedBuildMap,
  type PlaywrightBuildEntry,
} from './build-map.ts'
import { resolveBrowserExecutablePaths } from './playwright-install.ts'
import { readProjectPinsFromConfig } from './project-pins.ts'
import { BrowserPinSchema, PIN_BROWSERS, type BrowserPin } from './schemas/pins.ts'
import { readVitestProjectPins } from './vitest-project-pins.ts'

const USAGE = `Usage: crvy-rprtr browsers <command> [options]

Commands:
  list [--all] [--refresh]                 List browser builds per Playwright release
  resolve <engine>@<version-prefix>        Resolve a pin prefix to a concrete build
  check [--strict]                         Check declared pins against the installed environment`

export interface BrowsersCommandDeps {
  cwd: string
  out: (line: string) => void
  err: (line: string) => void
  loadBuildMap: (options?: { refresh?: boolean }) => Promise<LoadedBuildMap | null>
  probeBuildMap: (baseVersion: string | null) => Promise<PlaywrightBuildEntry[]>
  readPins: (cwd: string) => Promise<readonly ResolvedProjectPin[]>
  executablePaths: () => Promise<Record<PinBrowser, string>>
}

function parseBrowserPinArg(value: string): BrowserPin | null {
  const separator = value.indexOf('@')
  if (separator <= 0) return null
  const parsed = BrowserPinSchema.safeParse({
    browser: value.slice(0, separator),
    version: value.slice(separator + 1),
  })
  return parsed.success ? parsed.data : null
}

function formatBuild(build: BrowserBuild): string {
  return build.revision === null ? build.version : `${build.version} (revision ${build.revision})`
}

function newestPlaywrightVersion(entries: readonly PlaywrightBuildEntry[]): string | null {
  const stable = entries.find((entry) => isStablePlaywrightVersion(entry.ver))
  return (stable ?? entries[0])?.ver ?? null
}

function reportOffline(deps: BrowsersCommandDeps): number {
  deps.err(
    'Could not load the Playwright build map: the CLI is offline and no usable cache exists. Retry with `crvy-rprtr browsers list --refresh` when online.',
  )
  return 1
}

async function runList(args: string[], deps: BrowsersCommandDeps): Promise<number> {
  const { values } = parseArgs({
    args,
    allowPositionals: true,
    options: { all: { type: 'boolean' }, refresh: { type: 'boolean' } },
  })
  const loaded = await deps.loadBuildMap({ refresh: values.refresh === true })
  if (loaded === null) return reportOffline(deps)

  for (const entry of loaded.entries) {
    if (values.all !== true && !isStablePlaywrightVersion(entry.ver)) continue
    const date = entry.date === undefined ? '' : ` (${entry.date})`
    for (const browser of PIN_BROWSERS) {
      const raw = entry.browsers[browser]
      const build = raw === undefined ? null : parseBrowserBuild(raw)
      if (build === null) continue
      deps.out(`${browser} ${formatBuild(build)} — playwright ${entry.ver}${date}`)
    }
  }
  return 0
}

function printMatches(
  pin: BrowserPin,
  matches: readonly BuildMatch[],
  probed: boolean,
  deps: BrowsersCommandDeps,
): void {
  const [recommended, ...alternatives] = matches
  if (recommended === undefined) return
  deps.out(`${pin.browser} ${formatBuild(recommended.browser)}`)
  deps.out(`recommended: playwright ${recommended.playwrightVersion}${probed ? ' (probed)' : ''}`)
  for (const alternative of alternatives) {
    deps.out(
      `alternative: playwright ${alternative.playwrightVersion} — ${pin.browser} ${formatBuild(alternative.browser)}`,
    )
  }
}

function printInstalled(pin: BrowserPin, environment: ProjectEnvironment, deps: BrowsersCommandDeps): void {
  const effective =
    environment.browserVersion === null
      ? 'unverifiable on this platform'
      : formatBuild({ version: environment.browserVersion, revision: environment.revision })
  deps.out(
    `installed: playwright ${environment.playwrightVersion ?? 'unknown'} — ${pin.browser} ${effective} [${environment.status}]`,
  )
  if (environment.status === 'drift') deps.out(`remedy: ${defaultPinRemedy(pin)}`)
}

async function runResolve(args: string[], deps: BrowsersCommandDeps): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { refresh: { type: 'boolean' } },
  })
  const target = positionals[0]
  const pin = target === undefined ? null : parseBrowserPinArg(target)
  if (pin === null) {
    deps.err(
      `Invalid browser pin "${target ?? ''}": expected <engine>@<version-prefix> with browser chromium, firefox, or webkit and a numeric version — for example chromium@147.`,
    )
    return 1
  }

  const loaded = await deps.loadBuildMap({ refresh: values.refresh === true })
  if (loaded === null) return reportOffline(deps)
  let entries = loaded.entries
  let matches = findBuilds(entries, pin.browser, pin.version)
  let probed = false
  if (matches.length === 0) {
    const base = newestPlaywrightVersion(entries) ?? resolvePlaywrightVersion(deps.cwd)
    const probedEntries = await deps.probeBuildMap(base)
    if (probedEntries.length > 0) {
      entries = [...probedEntries, ...entries]
      matches = findBuilds(entries, pin.browser, pin.version)
      probed = matches.length > 0
    }
  }
  if (matches.length === 0) {
    deps.err(`No build matches ${pin.browser}@${pin.version}.`)
    const nearest = nearestMajors(entries, pin.browser, pin.version)
    if (nearest.length > 0) deps.err(`Nearest ${pin.browser} majors: ${nearest.join(', ')}`)
    return 1
  }

  printMatches(pin, matches, probed, deps)
  const environment = readInstalledEnvironment({
    cwd: deps.cwd,
    browser: pin.browser,
    executablePath: (await deps.executablePaths())[pin.browser],
    pin,
  })
  printInstalled(pin, environment, deps)
  return 0
}

async function runCheck(args: string[], deps: BrowsersCommandDeps): Promise<number> {
  const { values } = parseArgs({
    args,
    allowPositionals: true,
    options: { strict: { type: 'boolean' } },
  })
  const projects = await deps.readPins(deps.cwd)
  if (!projects.some((project) => project.pin !== undefined)) {
    deps.out('No browser pins declared.')
    return 0
  }

  const paths = await deps.executablePaths()
  let drifted = 0
  for (const project of projects) {
    const pin = project.pin
    if (pin === undefined) continue
    if (project.invalidReason !== undefined) {
      deps.out(`${project.projectName}: invalid pin — ${project.invalidReason}`)
      drifted += 1
      continue
    }
    if (project.unverifiable === true) {
      deps.out(
        `${project.projectName}: pins ${pin.browser}@${pin.version} — unverifiable on this runner [unverifiable]`,
      )
      continue
    }
    const environment = readInstalledEnvironment({
      cwd: deps.cwd,
      browser: project.browser,
      executablePath: paths[project.browser],
      pin,
      ...(project.channel === undefined ? {} : { channel: project.channel }),
      ...(project.launchExecutablePath === undefined ? {} : { launchExecutablePath: project.launchExecutablePath }),
    })
    const effective =
      environment.browserVersion === null
        ? 'unverifiable on this platform'
        : `${environment.browserVersion}${environment.revision === null ? '' : ` (revision ${environment.revision})`}`
    deps.out(
      `${project.projectName}: pins ${pin.browser}@${pin.version} — effective ${effective} [${environment.status}]`,
    )
    if (environment.status === 'drift') drifted += 1
  }
  return values.strict === true && drifted > 0 ? 1 : 0
}

export interface ReadAllProjectPinsDeps {
  readPlaywrightPins?: (cwd: string) => Promise<readonly ResolvedProjectPin[]>
  readVitestPins?: (cwd: string) => Promise<readonly ResolvedProjectPin[]>
}

/**
 * Reads declared pins from both runners and merges them. A runner without a
 * readable config contributes nothing: `check` reports no pins for it instead
 * of failing the whole command.
 */
export async function readAllProjectPins(
  cwd: string,
  deps: ReadAllProjectPinsDeps = {},
): Promise<ResolvedProjectPin[]> {
  const readPlaywright = deps.readPlaywrightPins ?? readProjectPinsFromConfig
  const readVitest = deps.readVitestPins ?? readVitestProjectPins
  const [playwright, vitest] = await Promise.all([readPlaywright(cwd), readVitest(cwd)])
  return [...playwright, ...vitest]
}

export async function runBrowsersCommand(args: string[], deps: BrowsersCommandDeps): Promise<number> {
  const [subcommand, ...rest] = args
  try {
    switch (subcommand) {
      case 'list':
        return await runList(rest, deps)
      case 'resolve':
        return await runResolve(rest, deps)
      case 'check':
        return await runCheck(rest, deps)
      case undefined:
        deps.err(USAGE)
        return 1
      default:
        deps.err(`Unknown browsers subcommand: ${subcommand}\n\n${USAGE}`)
        return 1
    }
  } catch (error) {
    deps.err(error instanceof Error ? error.message : String(error))
    return 1
  }
}

/** Wires the real build-map cache, config readers, and installed browser types. */
export function createDefaultBrowsersDeps(cwd: string = process.cwd()): BrowsersCommandDeps {
  return {
    cwd,
    out: (line): void => {
      console.log(line)
    },
    err: (line): void => {
      console.error(line)
    },
    loadBuildMap,
    probeBuildMap: (baseVersion) => probeBuildMap(candidateProbeVersions(baseVersion)),
    readPins: readAllProjectPins,
    executablePaths: (): Promise<Record<PinBrowser, string>> => {
      const paths = resolveBrowserExecutablePaths(cwd)
      if (paths === null) {
        return Promise.reject(
          new Error(
            'Could not resolve the installed Playwright browsers: install `playwright` or `@playwright/test` in the project.',
          ),
        )
      }
      return Promise.resolve(paths)
    },
  }
}
