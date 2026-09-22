/**
 * Pure model behind `scripts/release-preflight.ts`: version derivation (which
 * mirrors the release workflow's own arithmetic), changelog entry counting,
 * option parsing, and report rendering. Everything here is free of process or
 * filesystem access so the gate evaluators can be driven by a fake runner.
 */
import { z } from 'zod'

export type Bump = 'patch' | 'minor' | 'major'
export type GateId = 'worktree' | 'branch' | 'clean' | 'sync' | 'changelog' | 'tag' | 'registry' | 'auth' | 'checks'
export type GateStatus = 'pass' | 'fail' | 'skipped'

export interface GateResult {
  id: GateId
  status: GateStatus
  detail: string
  remediation?: string
}

export interface PreflightOptions {
  bump: Bump
  branch: string
  remote: string
  json: boolean
  fast: boolean
}

export interface PreflightReport {
  bump: Bump
  branch: string
  currentVersion: string
  nextVersion: string
  nextTag: string
  ready: boolean
  gates: GateResult[]
}

export type ParseResult = { ok: true; options: PreflightOptions } | { ok: false; error: string }

export interface CommandResult {
  status: number
  stdout: string
  stderr: string
}

export type CommandRunner = (command: string[]) => CommandResult

const optionsSchema = z.object({
  bump: z.enum(['patch', 'minor', 'major']),
  branch: z.string().min(1).default('main'),
  remote: z.string().min(1).default('origin'),
  json: z.boolean().default(false),
  fast: z.boolean().default(false),
})

/**
 * Mirrors the "Calculate next version" step in `.github/workflows/publish.yml`.
 * Keep the two in sync when the workflow changes.
 */
export function computeVersions(
  latestTag: string | null,
  bump: Bump,
): { current: string; next: string; nextTag: string } {
  const current = (latestTag ?? 'v0.0.0').replace(/^v/, '')
  const [major = 0, minor = 0, patch = 0] = current.split('.').map((segment) => Number.parseInt(segment, 10))
  const next =
    bump === 'major'
      ? `${major + 1}.0.0`
      : bump === 'minor'
        ? `${major}.${minor + 1}.0`
        : `${major}.${minor}.${patch + 1}`
  return { current, next, nextTag: `v${next}` }
}

export function countChangelogEntries(markdown: string): number {
  return markdown.split('\n').filter((line) => line.startsWith('- ')).length
}

type RawOptions = { bump?: string; branch?: string; remote?: string; json?: boolean; fast?: boolean }

function collectOptions(argv: string[]): { ok: true; raw: RawOptions } | { ok: false; error: string } {
  const raw: RawOptions = {}
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index] ?? ''
    switch (flag) {
      case '--bump':
      case '--branch':
      case '--remote': {
        const value = argv[index + 1]
        if (value === undefined || value.startsWith('--')) return { ok: false, error: `${flag} requires a value` }
        if (flag === '--bump') raw.bump = value
        if (flag === '--branch') raw.branch = value
        if (flag === '--remote') raw.remote = value
        index++
        break
      }
      case '--json':
        raw.json = true
        break
      case '--fast':
        raw.fast = true
        break
      default:
        return { ok: false, error: `Unknown option: ${flag}` }
    }
  }
  if (raw.bump === undefined) return { ok: false, error: 'Missing required option: --bump' }
  return { ok: true, raw }
}

export function parseOptions(argv: string[]): ParseResult {
  const collected = collectOptions(argv)
  if (!collected.ok) return collected
  const parsed = optionsSchema.safeParse(collected.raw)
  if (!parsed.success) {
    const [issue] = parsed.error.issues
    const flag = issue?.path.join('.') ?? 'options'
    return { ok: false, error: `Invalid --${flag}: ${issue?.message ?? 'invalid value'}` }
  }
  return { ok: true, options: parsed.data }
}

const MARKERS: Record<GateStatus, string> = { pass: '✓', fail: '✗', skipped: '-' }

export function renderTable(report: PreflightReport): string {
  const lines = [
    `Release preflight — bump ${report.bump}, branch ${report.branch}`,
    `  version ${report.currentVersion} -> ${report.nextVersion} (${report.nextTag})`,
    '',
  ]
  for (const gate of report.gates) {
    lines.push(`  ${MARKERS[gate.status]} ${gate.id.padEnd(10)} ${gate.detail}`)
    if (gate.remediation !== undefined) lines.push(`      → ${gate.remediation}`)
  }
  const failed = report.gates.filter((gate) => gate.status === 'fail').length
  const skipped = report.gates.filter((gate) => gate.status === 'skipped').length
  lines.push('')
  lines.push(
    report.ready
      ? `READY — dispatch the release workflow with bump_type=${report.bump}.`
      : `NOT READY — ${failed} gate(s) failed, ${skipped} not evaluated. Fix the failures and re-run the preflight.`,
  )
  return lines.join('\n')
}

export function renderJson(report: PreflightReport): string {
  return JSON.stringify(report, null, 2)
}
