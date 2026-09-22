import { connect } from 'node:net'

import pLimit from 'p-limit'

import { DOCKER_HOST_GATEWAY } from '../docker-contract.ts'
import type { DockerConfigSummary, DockerWebServer } from './config-dump.ts'

/** Short by design: a probe must not delay run preparation. */
const PROBE_TIMEOUT_MS = 2500

/** Bounded probing: distinct addresses, never a burst against the host. */
const HOST_PROBE_CONCURRENCY = 4

const DOCS_PATH = 'docs/docker-host-services.md'

/**
 * Injectable network seams for tests; the defaults use short-timeout HTTP and TCP
 * checks mirroring Playwright's own readiness semantics.
 */
export interface HostServiceProbe {
  /** HTTP status code for the address; null when unreachable. Below 404 counts as available. */
  http: (url: string) => Promise<number | null>
  /** TCP connect check, used for `port`-only webServer entries. */
  tcp: (host: string, port: number) => Promise<boolean>
}

export interface DockerHostDiagnosticDeps {
  /** Resolved Playwright config summary; null when the preflight listing could not produce one. */
  config: DockerConfigSummary | null
  /** Injectable probe seams for tests. */
  probe?: Partial<HostServiceProbe>
  /** Timeout for the default HTTP and TCP probes. */
  timeoutMs?: number
}

interface HostAddress {
  host: string
  port: number
  protocol: 'http' | 'https'
  path: string
  search: string
  /** Sanitized address for messages: no userinfo, query, or hash. */
  origin: string
  /** Dedupe key: lower-cased host and port. */
  key: string
  loopback: boolean
  gateway: boolean
  portOnly: boolean
}

type DiagnosticCandidate =
  | { kind: 'webserver'; address: HostAddress; entry: DockerWebServer }
  | { kind: 'baseurl'; address: HostAddress }

function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase()
  return normalized === 'localhost' || normalized === '::1' || /^127(?:\.\d{1,3}){3}$/.test(normalized)
}

function parseHostAddress(value: string): HostAddress | null {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (host === '') return null
  const protocol = url.protocol === 'https:' ? 'https' : 'http'
  const port = url.port === '' ? (protocol === 'https' ? 443 : 80) : Number(url.port)
  return {
    host,
    port,
    protocol,
    path: url.pathname === '' ? '/' : url.pathname,
    search: url.search,
    origin: `${protocol}://${url.host}`,
    key: `${host.toLowerCase()}:${port}`,
    loopback: isLoopbackHost(host),
    gateway: host.toLowerCase() === DOCKER_HOST_GATEWAY,
    portOnly: false,
  }
}

/** Playwright treats a `port`-only entry as `http://localhost:<port>` and waits on a TCP connect. */
function webServerAddress(entry: DockerWebServer): HostAddress | null {
  if (entry.url !== undefined) return parseHostAddress(entry.url)
  if (entry.port === undefined) return null
  const address = parseHostAddress(`http://localhost:${entry.port}`)
  return address === null ? null : { ...address, portOnly: true }
}

function probeUrl(address: HostAddress, host: string): string {
  return `${address.protocol}://${host}:${address.port}${address.path}${address.search}`
}

/** Playwright's readiness rule: any status below 404 counts, with `/` retried at `/index.html`. */
async function isHttpAvailable(probe: HostServiceProbe, url: string): Promise<boolean> {
  const status = await probe.http(url)
  if (status !== null && status >= 200 && status < 404) return true
  if (status !== 404 || new URL(url).pathname !== '/') return false
  const indexStatus = await probe.http(new URL('/index.html', url).toString())
  return indexStatus !== null && indexStatus >= 200 && indexStatus < 404
}

/**
 * A gateway address is probed at the gateway hostname first and at the loopback alias
 * second, so a host service bound to a non-loopback interface is not reported missing.
 */
async function isAddressAvailable(probe: HostServiceProbe, address: HostAddress): Promise<boolean> {
  if (address.portOnly) return probe.tcp(address.host, address.port)
  if (await isHttpAvailable(probe, probeUrl(address, address.host))) return true
  if (!address.gateway) return false
  return isHttpAvailable(probe, probeUrl(address, 'localhost'))
}

function createDefaultProbe(timeoutMs: number): HostServiceProbe {
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
  }
}

function resolveProbe(deps: DockerHostDiagnosticDeps): HostServiceProbe {
  const defaults = createDefaultProbe(deps.timeoutMs ?? PROBE_TIMEOUT_MS)
  return {
    http: deps.probe?.http ?? defaults.http,
    tcp: deps.probe?.tcp ?? defaults.tcp,
  }
}

function maskedNotice(address: HostAddress, entry: DockerWebServer): string {
  const target = entry.name === undefined ? address.origin : `[${entry.name}] ${address.origin}`
  const command = entry.command === undefined ? 'the webServer command' : `"${entry.command}"`
  return `Docker mode: Playwright will run ${command} inside the container instead of reusing the host service at ${target}. Derive webServer.url and baseURL from CRVY_RPRTR_DOCKER / CRVY_RPRTR_HOST_GATEWAY to address the host (see ${DOCS_PATH}).`
}

function uncoveredNotice(address: HostAddress): string {
  return `Docker mode: tests will address the container's own loopback at ${address.origin} instead of the host service answering there. Derive baseURL from CRVY_RPRTR_DOCKER / CRVY_RPRTR_HOST_GATEWAY to address the host (see ${DOCS_PATH}).`
}

function gatewayNotice(address: HostAddress): string {
  return `Docker mode: no host service answers at ${address.origin}; that address can only be served from the host, so the run will fail or time out. Start the service on the host or point the config at a container-local address (see ${DOCS_PATH}).`
}

/** Addresses are deduplicated and a baseURL served by a webServer entry is judged by that entry. */
function collectCandidates(config: DockerConfigSummary): DiagnosticCandidate[] {
  const candidates: DiagnosticCandidate[] = []
  const judged = new Set<string>()
  for (const entry of config.webServers) {
    const address = webServerAddress(entry)
    if (address === null || judged.has(address.key)) continue
    judged.add(address.key)
    candidates.push({ kind: 'webserver', address, entry })
  }
  for (const project of config.projects) {
    if (project.baseURL === undefined) continue
    const address = parseHostAddress(project.baseURL)
    if (address === null || judged.has(address.key)) continue
    judged.add(address.key)
    candidates.push({ kind: 'baseurl', address })
  }
  return candidates
}

async function diagnoseCandidate(probe: HostServiceProbe, candidate: DiagnosticCandidate): Promise<string | null> {
  const { address } = candidate
  const available = await isAddressAvailable(probe, address)
  if (candidate.kind === 'webserver') {
    if (address.loopback && candidate.entry.reuseExistingServer === true && available) {
      return maskedNotice(address, candidate.entry)
    }
    return address.gateway && !available ? gatewayNotice(address) : null
  }
  if (address.loopback && available) return uncoveredNotice(address)
  return address.gateway && !available ? gatewayNotice(address) : null
}

/**
 * Host-service divergence diagnostic for docker mode: probes the host side of every
 * distinct `webServer` / `baseURL` address and returns warnings for the cases where
 * the container will diverge from the host. Never throws and never blocks — an
 * unresolvable config or a failed probe yields no notice.
 */
export async function diagnoseDockerHostServices(deps: DockerHostDiagnosticDeps): Promise<string[]> {
  const config = deps.config
  if (config === null) return []
  const probe = resolveProbe(deps)
  const candidates = collectCandidates(config)
  const limit = pLimit(HOST_PROBE_CONCURRENCY)
  const notices = await Promise.all(candidates.map((candidate) => limit(() => diagnoseCandidate(probe, candidate))))
  return notices.filter((notice): notice is string => notice !== null)
}
