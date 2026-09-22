import { describe, expect, spyOn, test } from 'bun:test'

import {
  computeVersions,
  countChangelogEntries,
  parseOptions,
  renderJson,
  renderTable,
  type CommandResult,
  type CommandRunner,
  type GateId,
  type GateResult,
  type PreflightReport,
} from '../scripts/release-preflight-core.ts'
import { evaluatePreflight, exitCodeFor, main } from '../scripts/release-preflight.ts'

function result(partial: Partial<CommandResult>): CommandResult {
  return { status: partial.status ?? 0, stdout: partial.stdout ?? '', stderr: partial.stderr ?? '' }
}

/** Every command a fully-green preflight for `v0.4.1` + `patch` would run. */
function happyResponses(): Record<string, CommandResult> {
  return {
    'git rev-parse --git-dir': result({ stdout: '.git\n' }),
    'git symbolic-ref --short -q HEAD': result({ stdout: 'main\n' }),
    'git status --porcelain': result({}),
    'git fetch --quiet origin main': result({}),
    'git rev-list --left-right --count HEAD...origin/main': result({ stdout: '0\t0\n' }),
    'git describe --tags --abbrev=0': result({ stdout: 'v0.4.1\n' }),
    'git-cliff --unreleased --tag v0.4.2': result({
      stdout: '## [0.4.2] - 2026-09-22\n\n### Fixed\n\n- **server:** fix a thing\n',
    }),
    'git rev-parse -q --verify refs/tags/v0.4.2': result({ status: 1, stderr: 'fatal: Needed a single revision\n' }),
    'git ls-remote --exit-code --tags origin refs/tags/v0.4.2': result({ status: 2 }),
    'npm view @crvy/rprtr@0.4.2 version': result({ status: 1, stderr: 'npm error code E404\n' }),
    'gh auth status': result({}),
    'bun run check': result({}),
  }
}

function fakeRunner(responses: Record<string, CommandResult>): CommandRunner {
  return (command) => {
    const response = responses[command.join(' ')]
    if (response === undefined) throw new Error(`unexpected command: ${command.join(' ')}`)
    return response
  }
}

function options(overrides: Partial<{ bump: 'patch' | 'minor' | 'major'; fast: boolean }> = {}): {
  bump: 'patch' | 'minor' | 'major'
  branch: string
  remote: string
  json: boolean
  fast: boolean
} {
  return {
    bump: overrides.bump ?? 'patch',
    branch: 'main',
    remote: 'origin',
    json: false,
    fast: overrides.fast ?? false,
  }
}

function gateOf(report: PreflightReport, id: GateId): GateResult {
  const found = report.gates.find((gate) => gate.id === id)
  if (found === undefined) throw new Error(`missing gate: ${id}`)
  return found
}

describe('computeVersions', () => {
  test('applies each bump type to the latest tag', () => {
    expect(computeVersions('v0.4.1', 'patch')).toEqual({ current: '0.4.1', next: '0.4.2', nextTag: 'v0.4.2' })
    expect(computeVersions('v0.4.1', 'minor')).toEqual({ current: '0.4.1', next: '0.5.0', nextTag: 'v0.5.0' })
    expect(computeVersions('v0.4.1', 'major')).toEqual({ current: '0.4.1', next: '1.0.0', nextTag: 'v1.0.0' })
  })

  test('accepts a tag without the v prefix', () => {
    expect(computeVersions('0.4.1', 'patch')).toEqual({ current: '0.4.1', next: '0.4.2', nextTag: 'v0.4.2' })
  })

  test('falls back to 0.0.0 when there is no release tag', () => {
    expect(computeVersions(null, 'patch')).toEqual({ current: '0.0.0', next: '0.0.1', nextTag: 'v0.0.1' })
    expect(computeVersions(null, 'minor')).toEqual({ current: '0.0.0', next: '0.1.0', nextTag: 'v0.1.0' })
  })
})

describe('countChangelogEntries', () => {
  test('counts rendered entry lines only', () => {
    const markdown =
      '## [0.4.2] - 2026-09-22\n\n### Fixed\n\n- **server:** one\n- **client:** two\n\n[0.4.2]: https://example.com\n'
    expect(countChangelogEntries(markdown)).toBe(2)
  })

  test('an unreleased range without entries renders zero', () => {
    expect(countChangelogEntries('## [0.4.2] - 2026-09-22\n\n[0.4.2]: https://example.com\n')).toBe(0)
    expect(countChangelogEntries('')).toBe(0)
  })
})

describe('parseOptions', () => {
  test('defaults branch, remote, and output flags', () => {
    const parsed = parseOptions(['--bump', 'patch'])
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.options).toEqual(options())
  })

  test('parses every flag', () => {
    const parsed = parseOptions(['--bump', 'minor', '--branch', 'develop', '--remote', 'upstream', '--json', '--fast'])
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.options).toEqual({ bump: 'minor', branch: 'develop', remote: 'upstream', json: true, fast: true })
    }
  })

  test('rejects a missing bump type', () => {
    const parsed = parseOptions([])
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.error).toContain('--bump')
  })

  test('rejects an invalid bump type', () => {
    const parsed = parseOptions(['--bump', 'nope'])
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.error).toContain('--bump')
  })

  test('rejects an unknown flag and a valueless flag', () => {
    expect(parseOptions(['--bump', 'patch', '--wat']).ok).toBe(false)
    expect(parseOptions(['--bump']).ok).toBe(false)
  })
})

describe('evaluatePreflight', () => {
  test('a fully-green checkout is ready and exits 0', () => {
    const report = evaluatePreflight(options(), fakeRunner(happyResponses()))
    expect(report.ready).toBe(true)
    expect(report.gates.map((gate) => gate.status)).toEqual(Array.from({ length: 9 }, () => 'pass'))
    expect(report.currentVersion).toBe('0.4.1')
    expect(report.nextVersion).toBe('0.4.2')
    expect(report.nextTag).toBe('v0.4.2')
    expect(exitCodeFor(report)).toBe(0)
  })

  test('a dirty work tree fails clean and never marks later gates as passed', () => {
    const report = evaluatePreflight(
      options(),
      fakeRunner({ ...happyResponses(), 'git status --porcelain': result({ stdout: ' M src/a.ts\n?? new.ts\n' }) }),
    )
    expect(gateOf(report, 'clean').status).toBe('fail')
    expect(gateOf(report, 'clean').detail).toContain('2')
    for (const id of ['sync', 'changelog', 'tag', 'registry', 'auth', 'checks'] as const) {
      expect(gateOf(report, id).status).toBe('skipped')
    }
    expect(report.ready).toBe(false)
    expect(exitCodeFor(report)).toBe(1)
  })

  test('a checkout behind the remote fails sync with the counts', () => {
    const report = evaluatePreflight(
      options(),
      fakeRunner({
        ...happyResponses(),
        'git rev-list --left-right --count HEAD...origin/main': result({ stdout: '0\t2\n' }),
      }),
    )
    const sync = gateOf(report, 'sync')
    expect(sync.status).toBe('fail')
    expect(sync.detail).toContain('2')
    expect(report.ready).toBe(false)
  })

  test('an existing local tag fails the tag gate', () => {
    const report = evaluatePreflight(
      options(),
      fakeRunner({ ...happyResponses(), 'git rev-parse -q --verify refs/tags/v0.4.2': result({ stdout: 'v0.4.2\n' }) }),
    )
    const tag = gateOf(report, 'tag')
    expect(tag.status).toBe('fail')
    expect(tag.detail).toContain('v0.4.2')
  })

  test('an existing remote tag fails the tag gate', () => {
    const report = evaluatePreflight(
      options(),
      fakeRunner({
        ...happyResponses(),
        'git ls-remote --exit-code --tags origin refs/tags/v0.4.2': result({ status: 0 }),
      }),
    )
    expect(gateOf(report, 'tag').status).toBe('fail')
    expect(gateOf(report, 'registry').status).toBe('skipped')
  })

  test('an already published version fails the registry gate', () => {
    const report = evaluatePreflight(
      options(),
      fakeRunner({ ...happyResponses(), 'npm view @crvy/rprtr@0.4.2 version': result({ stdout: '0.4.2\n' }) }),
    )
    const registry = gateOf(report, 'registry')
    expect(registry.status).toBe('fail')
    expect(registry.detail).toContain('0.4.2')
  })

  test('a registry query that is neither published nor a 404 fails closed', () => {
    const report = evaluatePreflight(
      options(),
      fakeRunner({
        ...happyResponses(),
        'npm view @crvy/rprtr@0.4.2 version': result({ status: 1, stderr: 'npm error network request failed\n' }),
      }),
    )
    expect(gateOf(report, 'registry').status).toBe('fail')
  })

  test('an unreleased range without entries fails the changelog gate', () => {
    const report = evaluatePreflight(
      options(),
      fakeRunner({ ...happyResponses(), 'git-cliff --unreleased --tag v0.4.2': result({ stdout: '## [0.4.2]\n' }) }),
    )
    expect(gateOf(report, 'changelog').status).toBe('fail')
  })

  test('a missing git-cliff fails with an install remediation', () => {
    const report = evaluatePreflight(
      options(),
      fakeRunner({
        ...happyResponses(),
        'git-cliff --unreleased --tag v0.4.2': result({ status: 127, stderr: 'Executable not found: git-cliff\n' }),
      }),
    )
    const changelog = gateOf(report, 'changelog')
    expect(changelog.status).toBe('fail')
    expect(changelog.remediation).toContain('git-cliff')
  })

  test('unauthenticated gh fails without echoing command output', () => {
    const report = evaluatePreflight(
      options(),
      fakeRunner({ ...happyResponses(), 'gh auth status': result({ status: 1, stderr: 'Token: gho_secret123\n' }) }),
    )
    const auth = gateOf(report, 'auth')
    expect(auth.status).toBe('fail')
    expect(auth.detail).toBe('gh is not authenticated')
    expect(auth.remediation).toContain('gh auth login')
    expect(renderJson(report)).not.toContain('gho_secret123')
    expect(renderTable(report)).not.toContain('gho_secret123')
  })

  test('--fast skips the checks gate and is never ready', () => {
    const report = evaluatePreflight(options({ fast: true }), fakeRunner(happyResponses()))
    expect(gateOf(report, 'checks').status).toBe('skipped')
    expect(report.ready).toBe(false)
    expect(exitCodeFor(report)).toBe(1)
  })

  test('a failing check names the command', () => {
    const report = evaluatePreflight(
      options(),
      fakeRunner({ ...happyResponses(), 'bun run check': result({ status: 1, stdout: 'lint failed\n' }) }),
    )
    const checks = gateOf(report, 'checks')
    expect(checks.status).toBe('fail')
    expect(checks.detail).toContain('bun run check')
  })

  test('a missing git work tree skips every other gate', () => {
    const report = evaluatePreflight(
      options(),
      fakeRunner({
        ...happyResponses(),
        'git rev-parse --git-dir': result({ status: 128, stderr: 'not a git repo\n' }),
      }),
    )
    expect(gateOf(report, 'worktree').status).toBe('fail')
    expect(report.gates.filter((gate) => gate.status === 'skipped')).toHaveLength(8)
    expect(report.ready).toBe(false)
  })
})

describe('renderJson', () => {
  test('emits the report contract as a single JSON document', () => {
    const report = evaluatePreflight(options(), fakeRunner(happyResponses()))
    const parsed: unknown = JSON.parse(renderJson(report))
    expect(parsed).toMatchObject({
      bump: 'patch',
      branch: 'main',
      currentVersion: '0.4.1',
      nextVersion: '0.4.2',
      nextTag: 'v0.4.2',
      ready: true,
    })
    if (typeof parsed !== 'object' || parsed === null) throw new Error('expected an object')
    const gates = (parsed as { gates: GateResult[] }).gates
    expect(gates).toHaveLength(9)
    expect(gates[0]).toMatchObject({ id: 'worktree', status: 'pass' })
  })
})

describe('renderTable', () => {
  test('marks ready and not-ready runs', () => {
    const ready = evaluatePreflight(options(), fakeRunner(happyResponses()))
    expect(renderTable(ready)).toContain('✓ worktree')
    expect(renderTable(ready)).toContain('READY —')

    const dirty = evaluatePreflight(
      options(),
      fakeRunner({ ...happyResponses(), 'git status --porcelain': result({ stdout: ' M src/a.ts\n' }) }),
    )
    const table = renderTable(dirty)
    expect(table).toContain('✗ clean')
    expect(table).toContain('- checks')
    expect(table).toContain('NOT READY')
  })
})

describe('main', () => {
  test('exits 0 for a ready run and 1 for --fast', () => {
    const log = spyOn(console, 'log').mockImplementation(() => {})
    try {
      expect(main(['--bump', 'patch'], fakeRunner(happyResponses()))).toBe(0)
      expect(main(['--bump', 'patch', '--fast'], fakeRunner(happyResponses()))).toBe(1)
    } finally {
      log.mockRestore()
    }
  })

  test('exits 2 on a usage error', () => {
    const error = spyOn(console, 'error').mockImplementation(() => {})
    const log = spyOn(console, 'log').mockImplementation(() => {})
    try {
      expect(main(['--bump', 'nope'], fakeRunner(happyResponses()))).toBe(2)
    } finally {
      error.mockRestore()
      log.mockRestore()
    }
  })
})
