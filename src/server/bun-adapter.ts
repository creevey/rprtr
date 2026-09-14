import type { ServerWebSocket } from 'bun'

import type { ServerApp } from './app.ts'
import { isWebSocketUpgradeRequest } from './routes.ts'

function logWebSocketError(prefix: string, error: unknown): void {
  const errorMsg = error instanceof Error ? error.message : String(error)
  console.error(`${prefix}:`, errorMsg)
}

function toMessageString(message: string | Buffer | ArrayBuffer | Uint8Array): string {
  if (typeof message === 'string') {
    return message
  }

  if (message instanceof ArrayBuffer) {
    return Buffer.from(message).toString()
  }

  return Buffer.from(message.buffer, message.byteOffset, message.byteLength).toString()
}

export function startBunServer(app: ServerApp): Bun.Server<undefined> {
  const bunServer = Bun.serve({
    port: app.port,
    fetch(req, server) {
      if (isWebSocketUpgradeRequest(req)) {
        if (server.upgrade(req)) {
          return
        }

        return new Response('WebSocket upgrade failed', { status: 400 })
      }

      return app.handleRequest(req)
    },
    websocket: {
      open(ws: ServerWebSocket) {
        app.wsClients.add(ws)
      },
      message(_ws: ServerWebSocket, message: string | Buffer | ArrayBuffer | Uint8Array) {
        app.handleWebSocketMessage(toMessageString(message)).catch((error: unknown) => {
          logWebSocketError('Error handling WebSocket message', error)
        })
      },
      close(ws: ServerWebSocket) {
        app.wsClients.delete(ws)
      },
    },
    development: {
      hmr: true,
      console: true,
    },
  })

  console.log(`Crvy Rprtr started at http://localhost:${app.port}`)
  return bunServer
}
