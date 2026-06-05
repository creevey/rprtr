import { applyTestBeginEvent, applyTestEndEvent, finalizeRunEvent } from '../report-state.ts'
import type { TestBeginData, TestEndData } from '../schemas.ts'
import type { TestData, WebSocketMessage } from '../types.ts'
import { broadcastToBrowsers } from './utils.ts'
import type { RuntimeWebSocket } from './ws.ts'

export interface HandlerContext {
  reportData: {
    isRunning: boolean
    tests: Record<string, TestData>
    browsers: string[]
    isUpdateMode: boolean
    screenshotDir: string
  }
  wsClients: Set<RuntimeWebSocket>
  currentRunIds: Set<string>
  saveReport: () => Promise<void>
}

export function handleTestBegin(ctx: HandlerContext, data: TestBeginData): void {
  const test = applyTestBeginEvent(ctx, data)
  ctx.reportData.isRunning = true
  console.log(`  ▶ [${test.browser ?? '?'}] ${test.title}`)
  broadcastToBrowsers(ctx.wsClients, { type: 'test-begin', data })
}

export function handleTestEnd(ctx: HandlerContext, data: TestEndData): void {
  const result = applyTestEndEvent(ctx, data)
  if (result !== null) {
    const { test, diffCount } = result
    const icon = data.status === 'passed' ? '✓' : data.status === 'skipped' ? '–' : '✗'
    const dur = data.duration === null || data.duration === undefined ? '' : ` (${data.duration}ms)`
    const diffNote = diffCount > 0 ? ` [${diffCount} diff(s)]` : ''
    const errNote = data.error !== null && data.error !== undefined ? `\n    Error: ${data.error}` : ''
    console.log(`  ${icon} [${test.browser}] ${test.title}${dur}${diffNote}${errNote}`)
  }
  broadcastToBrowsers(ctx.wsClients, { type: 'test-update', data })
}

export async function handleRunEnd(ctx: HandlerContext, data: WebSocketMessage['data']): Promise<void> {
  const { passed, failed, pending } = finalizeRunEvent(ctx)
  await ctx.saveReport()
  console.log(`\nRun complete — ${passed} passed, ${failed} failed, ${pending} skipped`)
  broadcastToBrowsers(ctx.wsClients, { type: 'run-end', data })
}

export function handleApprove(): void {
  // WebSocket approval messages are handled via HTTP /api/approve endpoint
  // This case handles any legacy or client-initiated WebSocket approval messages
  console.log('[Server] Received approve message via WebSocket (handled via HTTP API)')
}

export function handleSync(ctx: HandlerContext): void {
  // Sync messages request a state synchronization
  console.log('[Server] Received sync message')
  broadcastToBrowsers(ctx.wsClients, { type: 'sync', data: ctx.reportData })
}
