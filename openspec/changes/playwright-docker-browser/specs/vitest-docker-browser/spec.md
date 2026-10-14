# Spec Delta

## MODIFIED Requirements

### Requirement: Server-managed browser sidecar lifecycle

When a docker-mode run — Playwright or Vitest — requires browsers, the server SHALL ensure the playwright image is present (pulling with progress phases when missing), start a detached sidecar container running the playwright run-server, and reuse that warm container for subsequent runs. The server SHALL remove the sidecar container on shutdown and on the force-kill path. A sidecar-backed run SHALL NOT spawn until the sidecar endpoint accepts connections; a sidecar that never becomes ready SHALL surface the existing docker-unavailable failure reason.

#### Scenario: First docker-mode Vitest run pulls and starts the sidecar

- **WHEN** a run is requested in docker mode, the image is missing locally, and the daemon is reachable
- **THEN** the server pulls the image, starts the sidecar container, waits for endpoint readiness, and only then spawns the run's test process

#### Scenario: Subsequent runs reuse the warm sidecar

- **WHEN** a second docker-mode run is requested while the sidecar is still running and ready
- **THEN** no new container starts and the run spawns against the existing endpoint

#### Scenario: Playwright and Vitest runs share one warm sidecar

- **WHEN** a docker-mode Vitest run follows a docker-mode Playwright run on the same server
- **THEN** the existing warm sidecar is reused without starting a second container

#### Scenario: Sidecar never becomes ready

- **WHEN** the sidecar container starts but its endpoint does not accept connections within the readiness timeout
- **THEN** the run request fails with the docker-unavailable reason and no test process spawns

#### Scenario: Server shutdown removes the sidecar

- **WHEN** the server shuts down or force-kills a run
- **THEN** the sidecar container is removed

### Requirement: Image pinned to the project's Playwright version

The sidecar image SHALL be resolved from the run's project's installed `playwright` version (falling back to `@playwright/test`), producing the same version-pinned `mcr.microsoft.com/playwright:v<version>-noble` tag for both runners. An explicitly configured docker image SHALL take precedence. When no version resolves and no image is configured, docker-mode runs SHALL fail with docker-unavailable.

#### Scenario: Version-derived image tag

- **WHEN** the project has `playwright@1.59.0` installed and no custom image is configured
- **THEN** the sidecar runs `mcr.microsoft.com/playwright:v1.59.0-noble`

#### Scenario: Custom image override

- **WHEN** the server is configured with an explicit docker image
- **THEN** the sidecar uses that image and no version probe is required

#### Scenario: Both runners resolve the same image

- **WHEN** Playwright and Vitest docker-mode runs are requested for projects with the same installed Playwright version
- **THEN** both runs use the same sidecar image tag

### Requirement: Deterministic rendering inside the sidecar

Unless text antialiasing is explicitly inherited, the sidecar SHALL mount the same grayscale fontconfig drop-in at the same conf.d path the docker rendering contract specifies, and SHALL set `TZ=UTC`, `LANG=C.UTF-8`, `LC_ALL=C.UTF-8` — so screenshots taken through the sidecar share the rendering contract documented in docs/docker-screenshot-determinism.md and docs/text-antialiasing-determinism.md for either runner.

#### Scenario: Fontconfig drop-in mounted

- **WHEN** the sidecar starts with default font rendering settings
- **THEN** the grayscale fontconfig drop-in is mounted read-only into the container's conf.d and locale/timezone environment matches the docker rendering contract

#### Scenario: Inherited rendering skips the drop-in

- **WHEN** font rendering is configured as inherit
- **THEN** no fontconfig drop-in is mounted into the sidecar

#### Scenario: Both runners render through one pinned environment

- **WHEN** Playwright and Vitest docker-mode runs execute on the same server
- **THEN** their screenshots come from the same sidecar rendering pins and remain byte-identical for the same page

### Requirement: Sidecar run artifacts stay host-side

Screenshots, references, offline JSON reports, and the static HTML artifact for any sidecar-backed run SHALL be written on the host filesystem with host-resolvable paths in run reports and the live UI — no container path rewriting applies, because the runner and reporter execute on the host for both runners.

#### Scenario: Report paths resolve on the host

- **WHEN** a sidecar-backed run completes and streams results to the live UI
- **THEN** every test file path and screenshot path in the report and the offline artifacts resolves on the host without translation

#### Scenario: Playwright sidecar run writes host-side artifacts

- **WHEN** a docker-mode Playwright run completes
- **THEN** its screenshots, baselines, and reports carry host paths and need no container-to-host mapping
