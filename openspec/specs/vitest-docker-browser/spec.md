# vitest-docker-browser Specification

## Purpose

Gives Vitest browser-mode runs the same containerized rendering environment Playwright docker mode provides, by managing a warm `playwright run-server` sidecar container that a locally launched vitest connects to.

## Requirements

### Requirement: Server-managed browser sidecar lifecycle

When a docker-mode Vitest run requires browsers, the server SHALL ensure the playwright image is present (pulling with progress phases when missing), start a detached sidecar container running the playwright run-server, and reuse that warm container for subsequent runs. The server SHALL remove the sidecar container on shutdown and on the force-kill path. A Vitest run SHALL NOT spawn until the sidecar endpoint accepts connections; a sidecar that never becomes ready SHALL surface the existing docker-unavailable failure reason.

#### Scenario: First docker-mode Vitest run pulls and starts the sidecar

- **WHEN** a Vitest run is requested in docker mode, the image is missing locally, and the daemon is reachable
- **THEN** the server pulls the image, starts the sidecar container, waits for endpoint readiness, and only then spawns vitest

#### Scenario: Subsequent runs reuse the warm sidecar

- **WHEN** a second docker-mode Vitest run is requested while the sidecar is still running and ready
- **THEN** no new container starts and the run spawns against the existing endpoint

#### Scenario: Sidecar never becomes ready

- **WHEN** the sidecar container starts but its endpoint does not accept connections within the readiness timeout
- **THEN** the run request fails with the docker-unavailable reason and no vitest process spawns

#### Scenario: Server shutdown removes the sidecar

- **WHEN** the server shuts down or force-kills a run
- **THEN** the sidecar container is removed

### Requirement: Image pinned to the project's Playwright version

The sidecar image SHALL be resolved from the Vitest project's installed `playwright` version (falling back to `@playwright/test`), producing the same version-pinned `mcr.microsoft.com/playwright:v<version>-noble` tag the Playwright docker path uses. An explicitly configured docker image SHALL take precedence. When no version resolves and no image is configured, docker-mode Vitest runs SHALL fail with docker-unavailable.

#### Scenario: Version-derived image tag

- **WHEN** the Vitest project has `playwright@1.59.0` installed and no custom image is configured
- **THEN** the sidecar runs `mcr.microsoft.com/playwright:v1.59.0-noble`

#### Scenario: Custom image override

- **WHEN** the server is configured with an explicit docker image
- **THEN** the sidecar uses that image and no version probe is required

### Requirement: Deterministic rendering inside the sidecar

Unless text antialiasing is explicitly inherited, the sidecar SHALL mount the same grayscale fontconfig drop-in at the same conf.d path used by Playwright docker mode, and SHALL set `TZ=UTC`, `LANG=C.UTF-8`, `LC_ALL=C.UTF-8` — so Vitest sidecar screenshots share the rendering contract documented in docs/docker-screenshot-determinism.md and docs/text-antialiasing-determinism.md.

#### Scenario: Fontconfig drop-in mounted

- **WHEN** the sidecar starts with default font rendering settings
- **THEN** the grayscale fontconfig drop-in is mounted read-only into the container's conf.d and locale/timezone environment matches Playwright docker mode

#### Scenario: Inherited rendering skips the drop-in

- **WHEN** font rendering is configured as inherit
- **THEN** no fontconfig drop-in is mounted into the sidecar

### Requirement: Sidecar endpoint is loopback-only

The sidecar's published port SHALL bind to the loopback interface only, so the browser RPC endpoint (served on a guessable root path) is unreachable from other machines.

#### Scenario: Port published on loopback only

- **WHEN** the sidecar container starts
- **THEN** its port mapping binds to 127.0.0.1 on the host and the endpoint URL contains no credentials

### Requirement: Vitest runs compose with the sidecar endpoint

A docker-mode Vitest run SHALL launch vitest locally with the sidecar WebSocket endpoint injected via the documented `CRVY_RPRTR_BROWSER_WS` environment variable, while the reporter URL stays `ws://localhost:<port>` (no host-gateway rewrite). Selection flags (`--config`, `--project`, positional files, `-t`) SHALL be unchanged from local Vitest runs.

#### Scenario: Environment composition for a sidecar run

- **WHEN** vitest spawns for a docker-mode run
- **THEN** `CRVY_RPRTR_BROWSER_WS` points at the sidecar endpoint, `CRVY_RPRTR_SERVER_URL` points at localhost, and test selection flags match the local Vitest path

### Requirement: Sidecar run artifacts stay host-side

Screenshots, references, offline JSON reports, and the static HTML artifact for a sidecar-assisted Vitest run SHALL be written on the host filesystem with host-resolvable paths in run reports and the live UI — no container path rewriting applies to Vitest runs.

#### Scenario: Report paths resolve on the host

- **WHEN** a sidecar-assisted Vitest run completes and streams results to the live UI
- **THEN** every test file path and screenshot path in the report and the offline artifacts resolves on the host without translation
