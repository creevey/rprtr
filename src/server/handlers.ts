import { existsSync } from 'fs'
import { dirname, resolve } from 'path'

import type { RunEnvironments } from '../browser-pins.ts'
import { applyTestBeginEvent, applyTestEndEvent, finalizeRunEvent } from '../report-state.ts'
import type { RegisterData, RunEndData, TestBeginData, TestEndData } from '../schemas.ts'
import type { ClientWebSocketMessage, TestData } from '../types.ts'
import { resolveBaselineSnapshotPath, type ApprovalRouting } from './artifact-routes.ts'
import { rewriteContainerPath, type ContainerPathMapping } from './docker-support.ts'
import type { RoutesContext } from './routes.ts'
import type { RunController } from './run-controller.ts'
import { broadcastToBrowsers } from './utils.ts'
import type { RuntimeWebSocket } from './ws.ts'

export interface HandlerContext {
  reportData: {
    isRunning: boolean
    tests: Record<string, TestData>
    browsers: string[]
    isUpdateMode: boolean
    screenshotDir: string
    environments: RunEnvironments
  }
  wsClients: Set<RuntimeWebSocket>
  currentRunIds: Set<string>
  // True when the in-progress run was started with a filter (a subset of tests),
  // so run-end must NOT cull tests that were not part of this run.
  isFilteredRun: boolean
  saveReport: () => Promise<void>
  /** Debounced persistence; used after in-memory mutations so a crash or
   * interrupted run (no `run-end`) still leaves the latest state on disk. */
  scheduleReportSave: () => void
  approvalRouting?: ApprovalRouting
  routesContext: RoutesContext
  runController: RunController
}

export function handleTestBegin(ctx: HandlerContext, data: TestBeginData): void {
  const test = applyTestBeginEvent(ctx, data)
  ctx.reportData.isRunning = true
  ctx.scheduleReportSave()
  console.log(`  ▶ [${test.browser ?? '?'}] ${test.title}`)
  const message: ClientWebSocketMessage = { type: 'test-begin', data: test }
  broadcastToBrowsers(ctx.wsClients, message)
}

function enrichDeclaredBaselines(ctx: HandlerContext, test: TestData): void {
  const retry = (test.results?.length ?? 0) - 1
  const images = test.results?.[retry]?.images
  if (retry < 0 || images === undefined) {
    return
  }

  for (const [visualName, image] of Object.entries(images)) {
    if (image === undefined || image.source !== 'declared-only') {
      continue
    }

    const snapshotPath = resolveBaselineSnapshotPath(ctx.approvalRouting, test, retry, visualName)
    if (snapshotPath === null || !existsSync(snapshotPath)) {
      continue
    }

    image.expect = `/baseline/${encodeURIComponent(test.id)}/${retry}/${encodeURIComponent(visualName)}`
    image.source = 'baseline-only'
  }
}

export function handleTestEnd(ctx: HandlerContext, data: TestEndData): void {
  const result = applyTestEndEvent(ctx, data)
  if (result === null) {
    console.error('[Server] test-end for unknown test id:', data.id)
    return
  }
  const { test, diffCount } = result
  if (data.status === 'passed') {
    enrichDeclaredBaselines(ctx, test)
  }
  const icon = data.status === 'passed' ? '✓' : data.status === 'skipped' ? '–' : '✗'
  const dur = data.duration === null || data.duration === undefined ? '' : ` (${data.duration}ms)`
  const diffNote = diffCount > 0 ? ` [${diffCount} diff(s)]` : ''
  const errNote = data.error !== null && data.error !== undefined ? `\n    Error: ${data.error}` : ''
  console.log(`  ${icon} [${test.browser}] ${test.title}${dur}${diffNote}${errNote}`)
  ctx.scheduleReportSave()
  const message: ClientWebSocketMessage = { type: 'test-update', data: test }
  broadcastToBrowsers(ctx.wsClients, message)
}

export async function handleRunEnd(ctx: HandlerContext, data: RunEndData): Promise<void> {
  if (data.environments !== undefined) {
    Object.assign(ctx.reportData.environments, data.environments)
  }
  const removedTestIds = ctx.isFilteredRun
    ? []
    : Object.keys(ctx.reportData.tests).filter((id) => !ctx.currentRunIds.has(id))
  const { passed, failed, pending } = finalizeRunEvent(ctx, { preserveNonCurrent: ctx.isFilteredRun })
  await ctx.saveReport()
  console.log(`\nRun complete — ${passed} passed, ${failed} failed, ${pending} skipped`)
  const message: ClientWebSocketMessage = {
    type: 'run-end',
    data: { status: data.status, removedTestIds },
  }
  broadcastToBrowsers(ctx.wsClients, message)
}

export function handleApprove(): void {
  // WebSocket approval messages are handled via HTTP /api/approve endpoint
  // This case handles any legacy or client-initiated WebSocket approval messages
  console.log('[Server] Received approve message via WebSocket (handled via HTTP API)')
}

export function handleSync(ctx: HandlerContext): void {
  // Sync messages request a state synchronization
  console.log('[Server] Received sync message')
  broadcastSync(ctx)
}

function applyContainerPathMapping(rawData: RegisterData, mapping: ContainerPathMapping): RegisterData {
  return {
    ...rawData,
    playwrightSnapshotDir:
      rawData.playwrightSnapshotDir === undefined
        ? undefined
        : rewriteContainerPath(rawData.playwrightSnapshotDir, mapping),
    playwrightTestDir:
      rawData.playwrightTestDir === undefined ? undefined : rewriteContainerPath(rawData.playwrightTestDir, mapping),
    playwrightRootDir:
      rawData.playwrightRootDir === undefined ? undefined : rewriteContainerPath(rawData.playwrightRootDir, mapping),
    configFile: rawData.configFile === undefined ? undefined : rewriteContainerPath(rawData.configFile, mapping),
    cwd: rawData.cwd === undefined ? undefined : rewriteContainerPath(rawData.cwd, mapping),
  }
}

/** Every absolute directory a reporter may serve artifacts from, in registration order. */
function collectRegisterRoots(data: RegisterData): string[] {
  const roots: string[] = []
  for (const dir of [
    data.playwrightSnapshotDir,
    data.playwrightTestDir,
    data.vitestAttachmentsDir,
    data.vitestReferenceDir,
  ]) {
    if (dir !== undefined && dir !== '') roots.push(dir)
  }
  return roots
}

/** Pushes current state (tests + provenance) to connected browsers. */
function broadcastSync(ctx: HandlerContext): void {
  const message: ClientWebSocketMessage = {
    type: 'sync',
    data: {
      tests: ctx.reportData.tests,
      isUpdateMode: ctx.reportData.isUpdateMode,
      ...(Object.keys(ctx.reportData.environments).length === 0 ? {} : { environments: ctx.reportData.environments }),
    },
  }
  broadcastToBrowsers(ctx.wsClients, message)
}

export function handleRegister(ctx: HandlerContext, rawData: RegisterData): void {
  const mapping = ctx.routesContext.containerPathMapping
  const data: RegisterData = mapping === undefined ? rawData : applyContainerPathMapping(rawData, mapping)

  if (data.environments !== undefined) {
    Object.assign(ctx.reportData.environments, data.environments)
    // Push provenance to already-connected browsers; the run's tests stream next.
    broadcastSync(ctx)
  }

  const roots = collectRegisterRoots(data)

  const existing = ctx.routesContext.artifactRoots ?? []
  for (const root of roots) {
    if (!existing.includes(root)) {
      existing.push(root)
    }
  }
  ctx.routesContext.artifactRoots = existing

  if (ctx.routesContext.approvalRouting !== undefined) {
    if (data.playwrightSnapshotDir !== undefined) {
      ctx.routesContext.approvalRouting.playwrightSnapshotDir = data.playwrightSnapshotDir
    }
    if (data.playwrightTestDir !== undefined) {
      ctx.routesContext.approvalRouting.playwrightTestDir = data.playwrightTestDir
    }
    if (data.playwrightSnapshotPathTemplate !== undefined) {
      ctx.routesContext.approvalRouting.playwrightSnapshotPathTemplate = data.playwrightSnapshotPathTemplate
    }
    if (data.playwrightToHaveScreenshotPathTemplate !== undefined) {
      ctx.routesContext.approvalRouting.playwrightToHaveScreenshotPathTemplate =
        data.playwrightToHaveScreenshotPathTemplate
    }
  }

  if (data.configFile !== undefined && data.cwd !== undefined) {
    ctx.routesContext.runContext = buildRunContext(data.configFile, data.cwd, data)
  }

  console.log('[Server] Reporter registered with config:', {
    playwrightSnapshotDir: data.playwrightSnapshotDir,
    playwrightTestDir: data.playwrightTestDir,
    vitestAttachmentsDir: data.vitestAttachmentsDir,
    vitestReferenceDir: data.vitestReferenceDir,
    configFile: data.configFile,
    cwd: data.cwd,
    runner: data.runner,
  })
}

/**
 * The config dir is the project root the server mounts and spawns in. Older reporters
 * registered Playwright's `rootDir` as cwd — a testDir-derived subdirectory — so derive
 * cwd from the config file instead. `rootDir` keys --test-list entry matching.
 *
 * Vitest registers carry the project root as `cwd` directly: Vitest spawns from the
 * project root and has no testDir/rootDir templates, so both the spawn cwd and the
 * rootDir are the register's `cwd`.
 */
function buildRunContext(
  configFile: string,
  cwd: string,
  data: RegisterData,
): NonNullable<RoutesContext['runContext']> {
  if (data.runner === 'vitest') {
    return { configFile, cwd, rootDir: cwd, runner: 'vitest' }
  }
  const configDir = dirname(configFile)
  return {
    configFile,
    cwd: configDir,
    rootDir:
      data.playwrightRootDir ??
      (data.playwrightTestDir === undefined ? configDir : resolve(configDir, data.playwrightTestDir)),
    runner: 'playwright',
  }
}
