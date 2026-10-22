import { isAbsolute, relative, resolve, sep } from 'path'

import { warnTreePathCollisions } from '../report-tree.ts'
import type { TestData } from '../types.ts'
import type { RuntimeWebSocket } from './ws.ts'

export const LIVE_UPDATES_WEBSOCKET_PATH = '/'

/** Emits server-terminal collision warnings, deduped by the caller's signature set. */
export function warnReportTreePathCollisions(tests: Record<string, TestData>, reportedSignatures: Set<string>): void {
  warnTreePathCollisions(tests, reportedSignatures, (message) => {
    console.warn(`[Server] ${message}`)
  })
}

export function broadcastToBrowsers(wsClients: Set<RuntimeWebSocket>, msg: object): void {
  const payload = JSON.stringify(msg)
  wsClients.forEach((ws) => {
    ws.send(payload)
  })
}

export function isWebSocketUpgradeRequest(req: Request): boolean {
  return (
    new URL(req.url).pathname === LIVE_UPDATES_WEBSOCKET_PATH &&
    req.headers.get('upgrade')?.toLowerCase() === 'websocket'
  )
}

// Containment check via path.resolve (lexical) — does NOT follow symlinks, so callers
// must pass roots and targets that are consistently real or consistently symlinked.
export function isPathWithinRoots(target: string, roots: readonly string[]): boolean {
  const resolvedTarget = resolve(target)
  return roots.some((root) => {
    const rel = relative(resolve(root), resolvedTarget)
    return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
  })
}
