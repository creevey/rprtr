import { isAbsolute, relative, resolve, sep } from 'path'

import type { RuntimeWebSocket } from './ws.ts'

export const LIVE_UPDATES_WEBSOCKET_PATH = '/'

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

export function isPathWithinRoots(target: string, roots: readonly string[]): boolean {
  const resolvedTarget = resolve(target)
  return roots.some((root) => {
    const rel = relative(resolve(root), resolvedTarget)
    return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
  })
}
