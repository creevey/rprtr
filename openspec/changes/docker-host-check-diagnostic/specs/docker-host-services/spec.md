# Spec Delta

## ADDED Requirements

### Requirement: Host-header refusal diagnostic

The docker-mode host-service diagnostic SHALL detect a host service that answers on the host but refuses the hostname the container addresses it by, and warn without blocking the run. Detection SHALL apply to a host-gateway address (`host.docker.internal`) that answers on the host, returns `403` to a request carrying the gateway hostname as its `Host` header, and returns a non-403 status to the same request carrying the loopback name. The warning SHALL name the address, state that the container reaches the service but the service rejects the hostname, and name the remedy: allow the gateway hostname in the service's host-check configuration, or bind the service to all interfaces. The warning SHALL NOT be produced when the service answers the gateway hostname with a non-403 status, when it refuses the loopback name as well, or when it does not answer on the host at all.

#### Scenario: Storybook rejects the gateway hostname

- **WHEN** docker mode prepares a run whose config addresses `host.docker.internal` on a port where the host service answers, and the service returns `403` for a request with `Host: host.docker.internal:<port>` but not for `Host: localhost:<port>`
- **THEN** the server warns that the container reaches the service but its host check rejects the gateway hostname, names the address and the `allowedHosts` remedy, and the run proceeds

#### Scenario: Host check already allows the gateway hostname

- **WHEN** the host service answers the gateway hostname with a non-403 status
- **THEN** no host-header warning is emitted for that address

#### Scenario: Refusal is not a host check

- **WHEN** the host service returns `403` for both the gateway hostname and the loopback name, or does not answer at all
- **THEN** no host-header warning is emitted for that address

#### Scenario: Loopback addresses keep their existing notices

- **WHEN** a `webServer` or `baseURL` address is loopback
- **THEN** the host-header check does not run for it and the existing masked/uncovered notices apply unchanged

#### Scenario: Warning reaches the UI and the console only

- **WHEN** a host-header warning is produced for a prepared run
- **THEN** it is delivered with the run's preparation to connected browsers and written to the server console, and it does not appear in `report.json`, offline JSON reports, or the static HTML artifact

## MODIFIED Requirements

### Requirement: Docker-mode host-service divergence diagnostic

Before a Playwright run launches in docker mode, the server SHALL resolve the project's Playwright configuration through Playwright itself and inspect every declared `webServer` entry — object or array form — and every project's `use.baseURL`. It SHALL probe the host side of each distinct address and warn without blocking the run when the container will diverge from the host:

- a loopback address with `reuseExistingServer` intent while a service answers on the host: the container will not reuse the host service and will run the `webServer` command inside the container;
- a loopback `baseURL` not served by a declared `webServer` entry while a service answers on the host: tests will address the container's own loopback instead of the host service;
- a host-gateway address the container cannot reach: that address can only be served from the host, so the run will fail or time out;
- a host-gateway address the container reaches but the service refuses the gateway hostname: the container gets the service's error page, so tests fail or time out against it.

A host-gateway address SHALL count as reachable when a service answers at the gateway hostname or at one of the host's non-loopback IPv4 addresses. A service answering only at the host's loopback alias SHALL count as reachable only on Docker Desktop hosts (macOS and Windows); on Linux hosts — including WSL2 — a gateway address answering only at loopback SHALL be reported as a divergence whose warning names the loopback-only bind and the non-loopback bind remedy.

Addresses SHALL be deduplicated and a `baseURL` served by a `webServer` entry SHALL be judged by that entry's rules rather than independently. The diagnostic SHALL NOT warn when no service answers at a loopback address, when a host-gateway address is reachable, or when the configured host is neither loopback nor the host gateway. An unresolvable configuration or a failed listing SHALL produce no diagnostic and SHALL NOT block or fail the run. The probe SHALL mirror Playwright's readiness semantics, counting an HTTP response below 404 as available — including a dev server that returns 404 at `/` but 200 at `/index.html`. A reachable host-gateway address SHALL additionally be judged by the host-header refusal requirement above. Warned addresses SHALL be reported without credentials or token query parameters.

#### Scenario: Host service masked inside the container

- **WHEN** docker mode prepares a run whose config declares a loopback `webServer` with `reuseExistingServer: true`, and the host answers at that address
- **THEN** the server warns that Playwright will run the webServer command inside the container instead of reusing the host service, and the run proceeds

#### Scenario: Array-form webServer is diagnosed

- **WHEN** the config declares `webServer` as an array and an entry is a masked loopback service as above
- **THEN** the warning names that entry

#### Scenario: Loopback baseURL with a live host service

- **WHEN** docker mode prepares a run whose project `use.baseURL` is loopback, no `webServer` entry serves that address, and the host answers there
- **THEN** the server warns that tests will address the container's own loopback rather than the host service, and the run proceeds

#### Scenario: baseURL served by a webServer entry is not double-reported

- **WHEN** a loopback `baseURL` and a `webServer` entry share the same address
- **THEN** at most one warning is produced for that address, following the `webServer` entry's rules

#### Scenario: Gateway address without a host service

- **WHEN** docker mode prepares a run whose config addresses the host gateway and no service answers at any host address reachable from the container at that port
- **THEN** the server warns that the address can only be served from the host and that the run will fail or time out, and the run proceeds

#### Scenario: Linux gateway address answering only on loopback

- **WHEN** docker mode prepares a run on a Linux host whose config addresses the host gateway and the service answers only at the host's loopback alias
- **THEN** the server warns that the service is bound to loopback only and names the non-loopback bind remedy, and the run proceeds

#### Scenario: Docker Desktop gateway address answering on loopback

- **WHEN** docker mode prepares a run on a macOS or Windows host whose config addresses the host gateway and the service answers only at the host's loopback alias
- **THEN** no warning is emitted, because Docker Desktop forwards host loopback to containers

#### Scenario: Linux gateway address answering on a non-loopback interface

- **WHEN** docker mode prepares a run on a Linux host whose config addresses the host gateway and the service answers at a non-loopback IPv4 address of the host
- **THEN** no warning is emitted

#### Scenario: No warning without divergence

- **WHEN** a loopback address has no `reuseExistingServer` intent and is not referenced by a `baseURL`, or a host-gateway address is reachable from the container and accepts the gateway hostname
- **THEN** no warning is emitted

#### Scenario: Unresolvable config degrades silently

- **WHEN** the configuration cannot be resolved or the listing fails
- **THEN** no divergence warning is emitted and the run is unaffected

#### Scenario: Dev-server readiness heuristic matches Playwright

- **WHEN** a dev server answers 404 at `/` and 200 at `/index.html`
- **THEN** the address counts as available and no false "no host service" warning is emitted for a gateway address

#### Scenario: Credentials and tokens are not reported

- **WHEN** a warned address carries userinfo or a token query parameter
- **THEN** the warning text omits the credentials and the token
