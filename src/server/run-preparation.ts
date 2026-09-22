import type { PinBrowser, ResolvedProjectPin } from '../browser-pins.ts'
import type { ClientWebSocketMessage } from '../types.ts'
import type { BrowserSidecar } from './browser-sidecar.ts'
import type { RunContext } from './run-controller.ts'
import type { RunLauncher } from './run-launcher.ts'
import type { RunMode } from './run-mode.ts'
import { prepareVitestSidecarRun, resolveVitestBackend } from './vitest-backend.ts'

export interface RunPreparationDeps {
  launcher: RunLauncher
  getRunMode?: () => RunMode | undefined
  /** Warm browser sidecar backing docker-mode Vitest runs. */
  browserSidecar?: BrowserSidecar
  /** Vitest config hook scan; defaults to the textual `CRVY_RPRTR_BROWSER_WS` scan. */
  hasBrowserHook?: (configFile: string) => boolean
  /** Warning sink for run-mode fallbacks and pin diagnostics; defaults to console.warn. */
  warn?: (message: string) => void
  /** Reads declared Vitest pins for the sidecar preflight; defaults to the project's Vitest config. */
  readVitestPins?: (cwd: string) => Promise<readonly ResolvedProjectPin[]>
  /** Installed browser executable paths for the Vitest pin preflight; defaults to the project's Playwright. */
  browserExecutablePaths?: (cwd: string) => Record<PinBrowser, string> | null
  broadcast: (message: ClientWebSocketMessage) => void
}

export type PrepareRunResult =
  | { ok: true; sidecar?: { endpoint: string; image?: string }; notices?: string[] }
  | { ok: false; reason: 'docker-unavailable' }

function warnSink(deps: RunPreparationDeps): (message: string) => void {
  return (
    deps.warn ??
    ((message: string): void => {
      console.warn(message)
    })
  )
}

/**
 * Docker-only host-service diagnostic. Never blocks a run: a throwing hook is
 * treated as "no divergence known" — the run proceeds with no notices.
 */
async function collectNotices(launcher: RunLauncher): Promise<string[]> {
  if (launcher.diagnose === undefined) return []
  try {
    return await launcher.diagnose()
  } catch {
    return []
  }
}

/**
 * Prepares the launch environment for a run: the launcher's own preparation
 * for Playwright, and the managed browser sidecar for Vitest. Failures map to
 * the existing docker-unavailable start refusal.
 */
export async function prepareRunForContext(ctx: RunContext, deps: RunPreparationDeps): Promise<PrepareRunResult> {
  if (ctx.runner === 'vitest') return prepareVitestRun(ctx, deps)
  const launcher = deps.launcher
  if (launcher.prepare === undefined) return { ok: true }
  try {
    await launcher.prepare({
      ctx,
      onProgress: (phase) => {
        deps.broadcast({ type: 'run-status', data: { running: true, mode: launcher.mode, phase } })
      },
    })
    const notices = await collectNotices(launcher)
    return notices.length > 0 ? { ok: true, notices } : { ok: true }
  } catch (error) {
    deps.broadcast({ type: 'run-status', data: { running: false, mode: launcher.mode } })
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`[RunController] run preparation failed: ${message}`)
    return { ok: false, reason: 'docker-unavailable' }
  }
}

async function prepareVitestRun(ctx: RunContext, deps: RunPreparationDeps): Promise<PrepareRunResult> {
  const backend = resolveVitestBackend({
    ctx,
    runMode: deps.getRunMode?.(),
    dockerBackend: deps.launcher.mode === 'docker',
    warn: false,
    hasHook: deps.hasBrowserHook,
    warnSink: deps.warn,
  })
  if (backend !== 'sidecar') return { ok: true }
  const prepared = await prepareVitestSidecarRun({
    ctx,
    sidecar: deps.browserSidecar,
    warn: warnSink(deps),
    broadcast: deps.broadcast,
    ...(deps.readVitestPins === undefined ? {} : { readVitestPins: deps.readVitestPins }),
    ...(deps.browserExecutablePaths === undefined ? {} : { browserExecutablePaths: deps.browserExecutablePaths }),
  })
  if (!prepared.ok) return { ok: false, reason: 'docker-unavailable' }
  return {
    ok: true,
    sidecar: {
      endpoint: prepared.endpoint,
      ...(prepared.image === undefined ? {} : { image: prepared.image }),
    },
  }
}
