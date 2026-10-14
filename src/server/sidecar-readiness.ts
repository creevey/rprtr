import { connect } from 'node:net'

import type { DockerExec } from './docker-support.ts'

/** Module-private: bound for a single readiness TCP connect before counting it as failed. */
const READINESS_CONNECT_TIMEOUT_MS = 1000

export function tcpProbe(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port })
    const finish = (ok: boolean): void => {
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(READINESS_CONNECT_TIMEOUT_MS, () => {
      finish(false)
    })
    socket.once('connect', () => {
      finish(true)
    })
    socket.once('error', () => {
      finish(false)
    })
  })
}

/** Probes until the endpoint answers or the timeout elapses; injectable sleep keeps tests instant. */
export function waitForEndpoint(input: {
  probe: () => Promise<boolean>
  timeoutMs: number
  intervalMs: number
  sleep: (ms: number) => Promise<void>
}): Promise<boolean> {
  const attempt = async (waited: number): Promise<boolean> => {
    if (await input.probe()) return true
    if (waited >= input.timeoutMs) return false
    await input.sleep(input.intervalMs)
    return attempt(waited + input.intervalMs)
  }
  return attempt(0)
}

/** Resolves the host port docker published for the sidecar's container port. */
export async function resolvePublishedPort(
  exec: DockerExec,
  containerName: string,
  containerPort: number,
): Promise<number | null> {
  const result = await exec(['port', containerName, String(containerPort)])
  if (result.exitCode !== 0) return null
  for (const line of result.stdout.split('\n')) {
    const trimmed = line.trim()
    const index = trimmed.lastIndexOf(':')
    if (index === -1) continue
    const port = Number(trimmed.slice(index + 1))
    if (Number.isInteger(port) && port > 0 && port <= 65535) return port
  }
  return null
}
