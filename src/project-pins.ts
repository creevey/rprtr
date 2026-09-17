import { spawn } from 'node:child_process'

import { resolveProjectPins, type PlaywrightProjectLike, type ResolvedProjectPin } from './browser-pins.ts'
import { resolveLocalCommand } from './server/run-launcher.ts'

const LIST_TIMEOUT_MS = 60_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Reads pins out of Playwright's own JSON list report: `config.metadata` is the
 * config-root fallback, each `config.projects[]` carries the project's own
 * metadata. Returns [] for reports without a config section.
 */
export function parseProjectPinsFromListReport(report: unknown): ResolvedProjectPin[] {
  if (!isRecord(report)) return []
  const config = report.config
  if (!isRecord(config)) return []
  const projects = Array.isArray(config.projects) ? config.projects : []
  return resolveProjectPins({
    configMetadata: config.metadata,
    projects: projects.filter(isRecord).map((project) => project as PlaywrightProjectLike),
  })
}

/**
 * Spawns the project's own `playwright test --list --reporter=json`. Null when
 * the command fails without parseable output (no Playwright, broken config) —
 * callers treat that as "pins unknown", never as an error.
 */
export function readPlaywrightListReport(cwd: string): Promise<Record<string, unknown> | null> {
  const { cmd, args } = resolveLocalCommand('playwright', ['test', '--list', '--reporter=json'])
  return new Promise((resolve) => {
    let stdout = ''
    let settled = false
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    const finish = (value: Record<string, unknown> | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish(null)
    }, LIST_TIMEOUT_MS)
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    child.on('error', () => {
      finish(null)
    })
    child.on('close', () => {
      try {
        const parsed: unknown = JSON.parse(stdout)
        finish(isRecord(parsed) ? parsed : null)
      } catch {
        finish(null)
      }
    })
  })
}

/** Reads the declared browser pins from a Playwright config; [] when unresolvable. */
export async function readProjectPinsFromConfig(cwd: string): Promise<ResolvedProjectPin[]> {
  const report = await readPlaywrightListReport(cwd)
  return report === null ? [] : parseProjectPinsFromListReport(report)
}
