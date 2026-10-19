import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { connect } from 'node:net'

/** Short by design: a probe must not delay run preparation. */
export const PROBE_TIMEOUT_MS = 2500

/**
 * Injectable network seams for the docker host-service diagnostic; the defaults
 * use short-timeout HTTP, TCP, and explicit-`Host` checks.
 */
export interface HostServiceProbe {
  /** HTTP status code for the address; null when unreachable. Below 404 counts as available. */
  http: (url: string) => Promise<number | null>
  /** TCP connect check, used for `port`-only webServer entries. */
  tcp: (host: string, port: number) => Promise<boolean>
  /**
   * HTTP status code for the address when the request carries `host` as its
   * `Host` header; null when unreachable. `fetch` drops caller-supplied `Host`
   * headers, so the default probe uses `node:http`/`node:https`.
   */
  hostHeader: (url: string, host: string) => Promise<number | null>
}

/**
 * Status for `url` carrying an explicit `Host` header. The timer covers the whole
 * request lifecycle — including DNS and connect — because a `timeout` socket
 * option only starts once a connection exists.
 */
function hostHeaderStatus(url: string, host: string, timeoutMs: number): Promise<number | null> {
  return new Promise<number | null>((resolve) => {
    let target: URL
    try {
      target = new URL(url)
    } catch {
      resolve(null)
      return
    }
    let settled = false
    let request: ReturnType<typeof httpRequest> | null = null
    const finish = (status: number | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(status)
    }
    const timer = setTimeout(() => {
      request?.destroy()
      finish(null)
    }, timeoutMs)
    const send = target.protocol === 'https:' ? httpsRequest : httpRequest
    try {
      request = send(
        {
          hostname: target.hostname.replace(/^\[|\]$/g, ''),
          port: target.port === '' ? undefined : Number(target.port),
          path: `${target.pathname}${target.search}`,
          method: 'GET',
          headers: { Host: host, Accept: '*/*' },
        },
        (response) => {
          response.resume()
          finish(response.statusCode ?? null)
        },
      )
    } catch {
      finish(null)
      return
    }
    request.once('error', () => {
      finish(null)
    })
    request.end()
  })
}

export function createDefaultProbe(timeoutMs: number): HostServiceProbe {
  return {
    http: async (url: string): Promise<number | null> => {
      try {
        const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) })
        return response.status
      } catch {
        return null
      }
    },
    tcp: (host: string, port: number): Promise<boolean> =>
      new Promise<boolean>((resolve) => {
        const socket = connect({ host, port })
        const finish = (value: boolean): void => {
          socket.destroy()
          resolve(value)
        }
        socket.setTimeout(timeoutMs, () => {
          finish(false)
        })
        socket.once('connect', () => {
          finish(true)
        })
        socket.once('error', () => {
          finish(false)
        })
      }),
    hostHeader: (url: string, host: string): Promise<number | null> => hostHeaderStatus(url, host, timeoutMs),
  }
}
