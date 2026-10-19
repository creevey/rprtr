import { networkInterfaces } from 'node:os'

import pLimit from 'p-limit'

import { DOCKER_HOST_GATEWAY } from '../docker-contract.ts'
import type { DockerConfigSummary, DockerWebServer } from './config-dump.ts'
import { createDefaultProbe, PROBE_TIMEOUT_MS, type HostServiceProbe } from './host-service-probe.ts'

/** Bounded probing: distinct addresses, never a burst against the host. */
const HOST_PROBE_CONCURRENCY = 4

const DOCS_PATH = 'docs/docker-host-services.md'

export interface DockerHostDiagnosticDeps {
  /** Resolved Playwright config summary; null when the preflight listing could not produce one. */
  config: DockerConfigSummary | null
  /** Host platform the container will diverge from; defaults to `process.platform`. */
  platform?: NodeJS.Platform
  /** Injectable probe seams for tests. */
  probe?: Partial<HostServiceProbe>
  /** Injectable host-interface seam for tests; defaults to the host's non-internal IPv4 addresses. */
  hostAddresses?: () => readonly string[]
  /** Timeout for the default HTTP and TCP probes. */
  timeoutMs?: number
}

/** What a container would reach at a probed address, judged from the host platform. */
type Availability = 'reachable' | 'loopback-only' | 'unreachable'

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

/** How the container would reach an address, judged from the host platform. */
type ResolveOptions = { desktop: boolean; hostAddresses: readonly string[] }

/**
 * Probes the host's non-loopback addresses, in order, until one answers. The list is
 * the host's interfaces, so the recursion stays shallow; probing sequentially keeps
 * the short-circuit (and never exceeds the candidate's own concurrency slot).
 */
async function firstAnsweringHost(
  probe: HostServiceProbe,
  address: HostAddress,
  hosts: readonly string[],
  index = 0,
): Promise<string | null> {
  const host = hosts[index]
  if (host === undefined) return null
  if (!isLoopbackHost(host) && (await isHttpAvailable(probe, probeUrl(address, host)))) return host
  return firstAnsweringHost(probe, address, hosts, index + 1)
}

/** What the container can reach at a candidate address, and how the host reached it. */
interface Reachability {
  availability: Availability
  /** Host on which the address answered; null when nothing answered. */
  targetHost: string | null
}

/**
 * A gateway address is judged by what the container can reach: the gateway hostname
 * first, then the host's non-loopback IPv4 addresses, then the loopback alias —
 * which Docker Desktop forwards into containers but Linux does not.
 */
async function resolveAvailability(
  probe: HostServiceProbe,
  address: HostAddress,
  options: ResolveOptions,
): Promise<Reachability> {
  if (address.portOnly) {
    const reachable = await probe.tcp(address.host, address.port)
    return { availability: reachable ? 'reachable' : 'unreachable', targetHost: reachable ? address.host : null }
  }
  if (await isHttpAvailable(probe, probeUrl(address, address.host))) {
    return { availability: 'reachable', targetHost: address.host }
  }
  if (!address.gateway) return { availability: 'unreachable', targetHost: null }
  const host = await firstAnsweringHost(probe, address, options.hostAddresses)
  if (host !== null) return { availability: 'reachable', targetHost: host }
  if (!(await isHttpAvailable(probe, probeUrl(address, 'localhost')))) {
    return { availability: 'unreachable', targetHost: null }
  }
  return { availability: options.desktop ? 'reachable' : 'loopback-only', targetHost: 'localhost' }
}

/** The host's non-internal IPv4 addresses: the interfaces the gateway can route to. */
function hostNonLoopbackAddresses(): readonly string[] {
  const addresses = new Set<string>()
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) addresses.add(entry.address)
    }
  }
  return [...addresses]
}

/** Status a dev server's own host check returns for a hostname it does not allow. */
const HOST_CHECK_STATUS = 403

/** The `Host` header a browser sends for `host` at the address's protocol and port. */
function authority(address: HostAddress, host: string): string {
  const defaultPort = address.protocol === 'https' ? 443 : 80
  return address.port === defaultPort ? host : `${host}:${address.port}`
}

function resolveProbe(deps: DockerHostDiagnosticDeps): HostServiceProbe {
  const defaults = createDefaultProbe(deps.timeoutMs ?? PROBE_TIMEOUT_MS)
  return {
    http: deps.probe?.http ?? defaults.http,
    tcp: deps.probe?.tcp ?? defaults.tcp,
    hostHeader: deps.probe?.hostHeader ?? defaults.hostHeader,
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

function loopbackOnlyNotice(address: HostAddress): string {
  return `Docker mode: the host service at ${address.origin} answers only on the host's loopback alias, which a Linux container cannot reach through ${DOCKER_HOST_GATEWAY}. Bind the service to 0.0.0.0 (or a non-loopback interface) so the host gateway can reach it (see ${DOCS_PATH}).`
}

/** The divergence notice for a gateway address the container cannot reach, if any. */
function gatewayDivergence(address: HostAddress, availability: Availability): string | null {
  if (!address.gateway || availability === 'reachable') return null
  return availability === 'loopback-only' ? loopbackOnlyNotice(address) : gatewayNotice(address)
}

function hostCheckNotice(address: HostAddress): string {
  return `Docker mode: the host service at ${address.origin} rejects the gateway hostname with HTTP 403 while answering as localhost, so tests will see its error page instead of the app. Allow ${DOCKER_HOST_GATEWAY} in the dev server's host check (Storybook: core.allowedHosts; Vite: server.allowedHosts) or start it with --host 0.0.0.0 (see ${DOCS_PATH}).`
}

/**
 * A reachable gateway address is refused when the service answers 403 to the
 * hostname the container sends but not to the host's loopback name. Storybook's
 * core server and Vite's preview layer both implement such a check; a service
 * that refuses both names (auth, ACL) stays silent.
 */
async function hostHeaderDivergence(
  probe: HostServiceProbe,
  address: HostAddress,
  targetHost: string,
): Promise<string | null> {
  if (!address.gateway) return null
  const url = probeUrl(address, targetHost)
  if ((await probe.hostHeader(url, authority(address, DOCKER_HOST_GATEWAY))) !== HOST_CHECK_STATUS) return null
  const loopback = await probe.hostHeader(url, authority(address, 'localhost'))
  if (loopback === null || loopback === HOST_CHECK_STATUS) return null
  return hostCheckNotice(address)
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

async function diagnoseCandidate(
  probe: HostServiceProbe,
  candidate: DiagnosticCandidate,
  options: ResolveOptions,
): Promise<string | null> {
  const { address } = candidate
  const { availability, targetHost } = await resolveAvailability(probe, address, options)
  if (candidate.kind === 'webserver') {
    if (address.loopback && candidate.entry.reuseExistingServer === true && availability === 'reachable') {
      return maskedNotice(address, candidate.entry)
    }
  } else if (address.loopback && availability === 'reachable') {
    return uncoveredNotice(address)
  }
  const divergence = gatewayDivergence(address, availability)
  if (divergence !== null) return divergence
  if (availability !== 'reachable' || targetHost === null) return null
  return hostHeaderDivergence(probe, address, targetHost)
}

/** Docker Desktop forwards host loopback into containers; every other platform follows the Linux rule. */
const DOCKER_DESKTOP_PLATFORMS = new Set<NodeJS.Platform>(['darwin', 'win32'])

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
  const options = {
    desktop: DOCKER_DESKTOP_PLATFORMS.has(deps.platform ?? process.platform),
    hostAddresses: (deps.hostAddresses ?? hostNonLoopbackAddresses)(),
  }
  const candidates = collectCandidates(config)
  const limit = pLimit(HOST_PROBE_CONCURRENCY)
  const notices = await Promise.all(
    candidates.map((candidate) => limit(() => diagnoseCandidate(probe, candidate, options))),
  )
  return notices.filter((notice): notice is string => notice !== null)
}
