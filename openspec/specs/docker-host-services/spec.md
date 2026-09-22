# docker-host-services Specification

## Purpose

Lets Docker-mode Playwright runs reach services that run on the host — dev servers declared by `webServer` and origins tests navigate to via `baseURL` — and makes the cases where the container silently diverges from the host visible to the user instead of masking them.

## Requirements

### Requirement: Host gateway environment contract

A Playwright run launched in docker mode SHALL export `CRVY_RPRTR_DOCKER=1` and `CRVY_RPRTR_HOST_GATEWAY=host.docker.internal` into the container so project configurations can derive host-addressed URLs. Playwright local runs and Vitest runs — including sidecar-backed runs, whose test process runs on the host — SHALL NOT set either variable. The contract SHALL NOT alter the container's rendering pins: the pinned timezone, locale, and grayscale fontconfig SHALL remain in effect alongside the gateway variables. A host environment that already defines either variable name SHALL NOT override the values rprtr sets.

#### Scenario: Docker run carries the gateway contract

- **WHEN** a Playwright run is launched in docker mode
- **THEN** the container environment contains `CRVY_RPRTR_DOCKER=1` and `CRVY_RPRTR_HOST_GATEWAY=host.docker.internal` together with the existing server URL, portable-artifact, timezone, locale, and fontconfig settings

#### Scenario: Local run has no gateway contract

- **WHEN** a Playwright run is launched in local mode
- **THEN** neither `CRVY_RPRTR_DOCKER` nor `CRVY_RPRTR_HOST_GATEWAY` is present in the spawned environment

#### Scenario: Sidecar Vitest run stays host-local

- **WHEN** a Vitest run is launched against the docker browser sidecar
- **THEN** neither variable is set for the vitest process, because that process runs on the host

#### Scenario: Host environment cannot shadow the contract

- **WHEN** the server host environment already defines `CRVY_RPRTR_DOCKER` or `CRVY_RPRTR_HOST_GATEWAY` with different values
- **THEN** the container receives rprtr's own values

### Requirement: Docker-mode host-service divergence diagnostic

Before a Playwright run launches in docker mode, the server SHALL resolve the project's Playwright configuration through Playwright itself and inspect every declared `webServer` entry — object or array form — and every project's `use.baseURL`. It SHALL probe the host side of each distinct address and warn without blocking the run when the container will diverge from the host:

- a loopback address with `reuseExistingServer` intent while a service answers on the host: the container will not reuse the host service and will run the `webServer` command inside the container;
- a loopback `baseURL` not served by a declared `webServer` entry while a service answers on the host: tests will address the container's own loopback instead of the host service;
- a host-gateway address while no corresponding service answers on the host: that address can only be served from the host, so the run will fail or time out.

Addresses SHALL be deduplicated and a `baseURL` served by a `webServer` entry SHALL be judged by that entry's rules rather than independently. The diagnostic SHALL NOT warn when no service answers at a loopback address, when a host-gateway address answers, or when the configured host is neither loopback nor the host gateway. An unresolvable configuration or a failed listing SHALL produce no diagnostic and SHALL NOT block or fail the run. The probe SHALL mirror Playwright's readiness semantics, counting an HTTP response below 404 as available — including a dev server that returns 404 at `/` but 200 at `/index.html`. Warned addresses SHALL be reported without credentials or token query parameters.

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

- **WHEN** docker mode prepares a run whose config addresses the host gateway and no service answers on the host at that port
- **THEN** the server warns that the address can only be served from the host and that the run will fail or time out, and the run proceeds

#### Scenario: No warning without divergence

- **WHEN** a loopback address has no `reuseExistingServer` intent and is not referenced by a `baseURL`, or a host-gateway address answers on the host
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

### Requirement: Divergence warnings reach the live UI

A divergence warning SHALL be delivered to connected browsers with the run's preparation and displayed for that run, and the same warning SHALL be written to the server console. Warnings SHALL NOT be persisted into report state: static HTML artifacts, offline JSON reports, and CLI artifact-directory sessions SHALL remain derived from run events and SHALL NOT contain divergence notices, and a CLI artifact-directory session SHALL not probe the host.

#### Scenario: Connected browsers display the warning

- **WHEN** a docker-mode run is prepared with a divergence warning while browsers are connected
- **THEN** each browser displays the warning for that run

#### Scenario: Server console carries the warning

- **WHEN** a divergence warning is produced
- **THEN** the server logs it

#### Scenario: Static artifact stays event-derived

- **WHEN** a warned run completes and the static HTML artifact is written
- **THEN** the artifact contains the run's results and no divergence notice

#### Scenario: Offline reports stay event-derived

- **WHEN** a warned run writes offline JSON reports
- **THEN** those reports contain no divergence notice

#### Scenario: CLI artifact-directory session is inert

- **WHEN** the CLI serves a downloaded artifact directory without launching tests
- **THEN** no host probing happens and no divergence notice appears
