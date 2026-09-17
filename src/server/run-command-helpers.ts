import { unlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { RunTestDescriptor } from '../schemas.ts'
import { buildTestListEntries } from './docker-support.ts'

/** The project name every requested test shares, or undefined for mixed/absent names. */
export function sharedProject(tests: RunTestDescriptor[]): string | undefined {
  const names = new Set(tests.map((t) => t.projectName ?? ''))
  if (names.size === 1) {
    const name = [...names][0]
    return name === '' ? undefined : name
  }
  return undefined
}

/** `MAJOR.MINOR` threshold check using only leading digits; ignores pre-release suffixes. False for unparseable input. */
export function gteMinor(version: string, major: number, minor: number): boolean {
  const match = /^(\d+)\.(\d+)/.exec(version.trim())
  if (match === null) return false
  const maj = parseInt(match[1]!, 10)
  const min = parseInt(match[2]!, 10)
  if (maj !== major) return maj > major
  return min >= minor
}

export const defaultWriteTempFile = (content: string): string => {
  const path = join(tmpdir(), `crvy-rprtr-test-list-${process.pid}-${Date.now()}.txt`)
  writeFileSync(path, content, 'utf8')
  return path
}

export function defaultDeleteTempFile(path: string): void {
  try {
    unlinkSync(path)
  } catch {
    // Ignore — the file may already be removed (e.g. double exit/error).
  }
}

export function resolveReporterDefault(cwd: string): string | null {
  try {
    return createRequire(join(cwd, 'package.json')).resolve('@crvy/rprtr')
  } catch {
    // Not installed in the project; fall through to the server's own package.
  }
  try {
    return createRequire(import.meta.url).resolve('@crvy/rprtr')
  } catch {
    return null
  }
}

export interface PlaywrightRunArgsInput {
  configFile: string
  cwd: string
  rootDir?: string
  update: boolean
  tests: RunTestDescriptor[] | undefined
  reporterModule: string | null
  /** True when the version-gated `--test-list` path must carry the selection. */
  useTestList: boolean
  /** `'posix'` for docker runs: in-container Playwright matches posix-separated entries. */
  pathStyle: 'host' | 'posix'
  writeTempFile: (content: string) => string
}

/**
 * Builds the `playwright test` arg vector. Docker: positional host file:line
 * filters cannot resolve in-container — `--test-list` covers any selection
 * count; `pathStyle: 'posix'` converts separators for the in-container runner.
 */
export function buildPlaywrightRunArgs(input: PlaywrightRunArgsInput): {
  args: string[]
  testListPath: string | null
} {
  const args = ['test', '--config', input.configFile]
  if (input.reporterModule !== null) args.push('--reporter', input.reporterModule)
  if (input.update) args.push('--update-snapshots')
  let testListPath: string | null = null
  if (input.useTestList && input.tests !== undefined) {
    const content = buildTestListEntries(input.tests, input.rootDir, input.cwd, input.pathStyle).join('\n')
    testListPath = input.writeTempFile(content)
    args.push('--test-list', testListPath)
  } else if (input.tests !== undefined && input.tests.length > 0) {
    const project = sharedProject(input.tests)
    // `--project=name` not `--project name`: --project is variadic, so the space form swallows
    // the next positional filter as another project name ("Project not found").
    if (project !== undefined) args.push(`--project=${project}`)
    for (const d of input.tests) {
      args.push(d.column === undefined ? `${d.file}:${d.line}` : `${d.file}:${d.line}:${d.column}`)
    }
  }
  return { args, testListPath }
}
