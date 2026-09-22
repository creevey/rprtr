## MODIFIED Requirements

### Requirement: Docker-mode host-service divergence diagnostic

Before a Playwright run launches in docker mode, the server SHALL resolve the project's Playwright configuration through Playwright itself and inspect every declared `webServer` entry — object or array form — and every project's `use.baseURL`. It SHALL probe the host side of each distinct address and warn without blocking the run when the container will diverge from the host:

- a loopback address with `reuseExistingServer` intent while a service answers on the host: the container will not reuse the host service and will run the `webServer` command inside the container;
- a loopback `baseURL` not served by a declared `webServer` entry while a service answers on the host: tests will address the container's own loopback instead of the host service;
- a host-gateway address the container cannot reach: that address can only be served from the host, so the run will fail or time out.

A host-gateway address SHALL count as reachable when a service answers at the gateway hostname or at one of the host's non-loopback IPv4 addresses. A service answering only at the host's loopback alias SHALL count as reachable only on Docker Desktop hosts (macOS and Windows); on Linux hosts — including WSL2 — a gateway address answering only at loopback SHALL be reported as a divergence whose warning names the loopback-only bind and the non-loopback bind remedy.

Addresses SHALL be deduplicated and a `baseURL` served by a `webServer` entry SHALL be judged by that entry's rules rather than independently. The diagnostic SHALL NOT warn when no service answers at a loopback address, when a host-gateway address is reachable, or when the configured host is neither loopback nor the host gateway. An unresolvable configuration or a failed listing SHALL produce no diagnostic and SHALL NOT block or fail the run. The probe SHALL mirror Playwright's readiness semantics, counting an HTTP response below 404 as available — including a dev server that returns 404 at `/` but 200 at `/index.html`. Warned addresses SHALL be reported without credentials or token query parameters.

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

- **WHEN** a loopback address has no `reuseExistingServer` intent and is not referenced by a `baseURL`, or a host-gateway address is reachable from the container
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
