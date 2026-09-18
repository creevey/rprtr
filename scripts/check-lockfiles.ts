#!/usr/bin/env bun
/**
 * A committed lockfile that resolves a dependency to an absolute filesystem
 * path only installs on the machine that produced it. `main` was red for five
 * runs because `examples/vitest-browser/bun.lock` pinned `@crvy/rprtr` to a
 * macOS temp directory, which no Linux runner has.
 */
import { $ } from 'bun'

/** `"name": ["name@<resolution>", …]` — the resolution is what must not be a local path. */
const RESOLUTION = /"[^"@\s]*@?[^"@\s]*@((?:\/|[A-Za-z]:\\)[^"]*)"/g

export function findAbsoluteResolutions(lockfileContent: string): string[] {
  const offenders: string[] = []
  for (const line of lockfileContent.split('\n')) {
    for (const match of line.matchAll(RESOLUTION)) {
      const [specifier] = match
      offenders.push(specifier.slice(1, -1))
    }
  }
  return offenders
}

if (import.meta.main) {
  const tracked = (await $`git ls-files`.text())
    .split('\n')
    .filter((path) => path.endsWith('bun.lock') || path.endsWith('package-lock.json'))

  const scanned = await Promise.all(
    tracked.map(async (path) => ({ path, offenders: findAbsoluteResolutions(await Bun.file(path).text()) })),
  )

  const failing = scanned.filter((result) => result.offenders.length > 0)
  for (const { path, offenders } of failing) {
    console.error(`✗ ${path} resolves ${offenders.length} dependency/dependencies to an absolute local path:`)
    for (const offender of offenders) console.error(`    ${offender}`)
  }

  if (failing.length > 0) {
    console.error('\nRegenerate the lockfile against the registry so it installs on every machine.')
    process.exit(1)
  }
  console.log(`✓ ${tracked.length} lockfile(s) resolve every dependency portably`)
}
