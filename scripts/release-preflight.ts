#!/usr/bin/env bun
/**
 * Fail-closed preflight for dispatching `.github/workflows/publish.yml`.
 *
 * The release workflow is not resumable: it derives the next version from
 * `git describe` and pushes a tag before publishing, so a second dispatch after
 * a partial failure computes the version after the unpublished one and silently
 * skips it. This preflight refuses to report a release as ready unless every
 * dispatch precondition holds, and reports per-gate evidence so a maintainer or
 * an agent can stop with a remediation instead of guessing.
 */
import {
  computeVersions,
  countChangelogEntries,
  parseOptions,
  renderJson,
  renderTable,
  type CommandRunner,
  type GateId,
  type GateStatus,
  type PreflightOptions,
  type PreflightReport,
} from './release-preflight-core.ts'

export type {
  Bump,
  CommandResult,
  GateId,
  GateResult,
  GateStatus,
  PreflightOptions,
  PreflightReport,
} from './release-preflight-core.ts'

const PACKAGE_NAME = '@crvy/rprtr'

const USAGE = `Usage: bun run release:preflight -- --bump <patch|minor|major> [--branch main] [--remote origin] [--json] [--fast]

Gates: worktree, branch, clean, sync, changelog, tag, registry, auth, checks.
Exit codes: 0 ready, 1 not ready, 2 usage error.`

type GateOutcome = { status: GateStatus; detail: string; remediation?: string }

interface GateContext {
  options: PreflightOptions
  run: CommandRunner
  currentVersion: string
  nextVersion: string
  nextTag: string
}

type GateDefinition = { id: GateId; evaluate: (context: GateContext) => GateOutcome }

function pass(detail: string): GateOutcome {
  return { status: 'pass', detail }
}

function fail(detail: string, remediation: string): GateOutcome {
  return { status: 'fail', detail, remediation }
}

function evaluateWorktree({ run }: GateContext): GateOutcome {
  const probe = run(['git', 'rev-parse', '--git-dir'])
  return probe.status === 0
    ? pass('Repository checkout detected')
    : fail('Not a git work tree', 'Run the preflight from the repository checkout')
}

function evaluateBranch({ options, run }: GateContext): GateOutcome {
  const probe = run(['git', 'symbolic-ref', '--short', '-q', 'HEAD'])
  const current = probe.stdout.trim()
  if (probe.status !== 0 || current === '') {
    return fail(`HEAD is detached, expected ${options.branch}`, `Check out ${options.branch} before releasing`)
  }
  return current === options.branch
    ? pass(`On ${options.branch}`)
    : fail(`HEAD is on ${current}, expected ${options.branch}`, `Check out ${options.branch} before releasing`)
}

function evaluateClean({ run }: GateContext): GateOutcome {
  const changed = run(['git', 'status', '--porcelain'])
    .stdout.split('\n')
    .filter((line) => line.trim() !== '').length
  return changed === 0
    ? pass('No uncommitted changes')
    : fail(`${changed} changed file(s) in the work tree`, 'Commit or stash the changes, then re-run the preflight')
}

function evaluateSync({ options, run }: GateContext): GateOutcome {
  const { remote, branch } = options
  const fetched = run(['git', 'fetch', '--quiet', remote, branch])
  if (fetched.status !== 0) {
    return fail(`Could not fetch ${remote}/${branch}`, `Check the network and that ${remote}/${branch} exists`)
  }
  const counts = run(['git', 'rev-list', '--left-right', '--count', `HEAD...${remote}/${branch}`])
    .stdout.trim()
    .split(/\s+/)
  const ahead = Number.parseInt(counts[0] ?? '0', 10)
  const behind = Number.parseInt(counts[1] ?? '0', 10)
  return ahead === 0 && behind === 0
    ? pass(`In sync with ${remote}/${branch}`)
    : fail(
        `${ahead} ahead and ${behind} behind ${remote}/${branch}`,
        `Pull or push so local and ${remote}/${branch} match`,
      )
}

function evaluateChangelog({ run, nextTag }: GateContext): GateOutcome {
  const rendered = run(['git-cliff', '--unreleased', '--tag', nextTag])
  if (rendered.status !== 0) {
    return fail(
      'git-cliff could not render the unreleased changelog',
      rendered.status === 127
        ? 'Install git-cliff (`bun add -g git-cliff`) and re-run the preflight'
        : 'Fix the git-cliff failure and re-run the preflight',
    )
  }
  const entries = countChangelogEntries(rendered.stdout)
  return entries === 0
    ? fail('No changelog entries for the unreleased range', 'Land a releasable commit or choose a different bump type')
    : pass(`${entries} changelog ${entries === 1 ? 'entry' : 'entries'} since the last release`)
}

function evaluateTag({ options, run, nextTag }: GateContext): GateOutcome {
  if (run(['git', 'rev-parse', '-q', '--verify', `refs/tags/${nextTag}`]).status === 0) {
    return fail(`${nextTag} already exists locally`, 'Choose a different bump type')
  }
  const remote = run(['git', 'ls-remote', '--exit-code', '--tags', options.remote, `refs/tags/${nextTag}`])
  if (remote.status === 0) return fail(`${nextTag} already exists on ${options.remote}`, 'Choose a different bump type')
  if (remote.status !== 2) {
    return fail(
      `Could not query ${options.remote} for ${nextTag}`,
      `Check the network and that ${options.remote} is reachable`,
    )
  }
  return pass(`${nextTag} is available`)
}

function evaluateRegistry({ run, nextVersion }: GateContext): GateOutcome {
  const published = run(['npm', 'view', `${PACKAGE_NAME}@${nextVersion}`, 'version'])
  if (published.status === 0)
    return fail(`${PACKAGE_NAME}@${nextVersion} is already published`, 'Choose a different bump type')
  if (published.status === 127) return fail('npm is not available', 'Install npm and re-run the preflight')
  if (/E404|404/.test(published.stderr)) return pass(`${nextVersion} is not published`)
  return fail('Could not query the npm registry', 'Check the network and retry the preflight')
}

function evaluateAuth({ run }: GateContext): GateOutcome {
  const status = run(['gh', 'auth', 'status'])
  if (status.status === 0) return pass('gh is authenticated')
  if (status.status === 127) return fail('gh is not available', 'Install the GitHub CLI and run `gh auth login`')
  return fail('gh is not authenticated', 'Run `gh auth login`')
}

function evaluateChecks({ options, run }: GateContext): GateOutcome {
  if (options.fast) return { status: 'skipped', detail: 'Skipped by --fast; the release is not ready without it' }
  return run(['bun', 'run', 'check']).status === 0
    ? pass('bun run check passed')
    : fail('bun run check failed', 'Fix the failing check and re-run the preflight')
}

const GATES: readonly GateDefinition[] = [
  { id: 'worktree', evaluate: evaluateWorktree },
  { id: 'branch', evaluate: evaluateBranch },
  { id: 'clean', evaluate: evaluateClean },
  { id: 'sync', evaluate: evaluateSync },
  { id: 'changelog', evaluate: evaluateChangelog },
  { id: 'tag', evaluate: evaluateTag },
  { id: 'registry', evaluate: evaluateRegistry },
  { id: 'auth', evaluate: evaluateAuth },
  { id: 'checks', evaluate: evaluateChecks },
]

function readLatestTag(run: CommandRunner): string | null {
  const described = run(['git', 'describe', '--tags', '--abbrev=0'])
  if (described.status !== 0) return null
  const tag = described.stdout.trim()
  return tag === '' ? null : tag
}

export function evaluatePreflight(options: PreflightOptions, run: CommandRunner): PreflightReport {
  const { current, next, nextTag } = computeVersions(readLatestTag(run), options.bump)
  const context: GateContext = { options, run, currentVersion: current, nextVersion: next, nextTag }
  const gates: PreflightReport['gates'] = []
  let halted = false
  for (const definition of GATES) {
    if (halted) {
      gates.push({ id: definition.id, status: 'skipped', detail: 'Not evaluated: an earlier gate failed' })
      continue
    }
    const outcome = definition.evaluate(context)
    gates.push({ id: definition.id, ...outcome })
    halted = outcome.status === 'fail'
  }
  return {
    bump: options.bump,
    branch: options.branch,
    currentVersion: current,
    nextVersion: next,
    nextTag,
    ready: gates.every((gate) => gate.status === 'pass'),
    gates,
  }
}

export function exitCodeFor(report: PreflightReport): number {
  return report.ready ? 0 : 1
}

function createSpawnRunner(): CommandRunner {
  return (command) => {
    const [executable, ...args] = command
    if (executable === undefined) return { status: 127, stdout: '', stderr: 'Empty command' }
    if (Bun.which(executable) === null)
      return { status: 127, stdout: '', stderr: `Executable not found: ${executable}` }
    const spawned = Bun.spawnSync({ cmd: [executable, ...args], stdout: 'pipe', stderr: 'pipe' })
    return { status: spawned.exitCode, stdout: spawned.stdout.toString(), stderr: spawned.stderr.toString() }
  }
}

export function main(argv: string[], run: CommandRunner = createSpawnRunner()): number {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE)
    return 0
  }
  const parsed = parseOptions(argv)
  if (!parsed.ok) {
    console.error(parsed.error)
    console.error(USAGE)
    return 2
  }
  const report = evaluatePreflight(parsed.options, run)
  console.log(parsed.options.json ? renderJson(report) : renderTable(report))
  return exitCodeFor(report)
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)))
}
