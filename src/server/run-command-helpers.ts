import { unlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { RunTestDescriptor } from '../schemas.ts'

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
