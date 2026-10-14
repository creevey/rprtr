# playwright-docker-browser Specification

## Purpose

Runs docker-mode Playwright suites from the host against the managed `playwright run-server` sidecar, so browsers and screenshots come from the pinned Playwright image while the test process, reporter, host services, and artifacts stay on the host.

## ADDED Requirements

### Requirement: Host-driven Playwright runs connect to the managed browser sidecar

Under docker run mode, a Playwright run SHALL execute the project's local `playwright test` command on the host and SHALL connect it to the managed browser sidecar through Playwright's own connection environment: `PW_TEST_CONNECT_WS_ENDPOINT` set to the sidecar's loopback endpoint and `PW_TEST_CONNECT_EXPOSE_NETWORK` set to `<loopback>`. The test process SHALL NOT be wrapped in a `docker run` invocation. The spawned environment SHALL address the live server at the local host and SHALL NOT carry `CI`. The injected connection SHALL take precedence over a config-declared `use.connectOptions`, so no Playwright configuration change is required for the browser connection.

#### Scenario: Docker-mode Playwright run composes the connection environment

- **WHEN** a Playwright run starts in docker mode after sidecar preparation
- **THEN** the spawned process environment carries `PW_TEST_CONNECT_WS_ENDPOINT` at the sidecar endpoint, `PW_TEST_CONNECT_EXPOSE_NETWORK` as `<loopback>`, and the local server URL, without `CI`
- **AND** the spawned command is the project's local `playwright test`, not a container invocation

#### Scenario: Config-declared connectOptions is overridden

- **WHEN** a project's config declares `use.connectOptions` and the run launches in docker mode
- **THEN** the run connects to the managed sidecar because the injected connection takes precedence

#### Scenario: Sidecar image is recorded with the run

- **WHEN** a docker-mode Playwright run spawns
- **THEN** the spawned environment names the sidecar's Docker image so the recorded run environment includes it

### Requirement: Host services run on the host

Because the test process runs on the host, `webServer` entries SHALL start or be reused on the host, and `webServer.url` and `use.baseURL` values written for the host — including loopback addresses — SHALL remain valid as written. Container browsers SHALL reach host loopback services through the sidecar's loopback exposure rather than through a host-gateway hostname. The server SHALL NOT inject a host-gateway environment contract into docker-mode Playwright runs.

#### Scenario: Loopback webServer runs on the host

- **WHEN** docker mode prepares a run whose config declares a loopback `webServer`
- **THEN** Playwright starts or reuses that service on the host, and the run proceeds without a gateway rewrite

#### Scenario: Tests reach a host service through the exposed loopback

- **WHEN** tests navigate to a host loopback address while the browser runs in the sidecar
- **THEN** the connection is dialed from the host through the sidecar's loopback exposure instead of from the container's own loopback

### Requirement: Baseline resolution follows Playwright's snapshot naming

The server and the reporter SHALL resolve baseline file targets for docker-mode Playwright runs exactly as Playwright resolves its own snapshot paths: a project-declared `snapshotPathTemplate` SHALL be honored, and without one the snapshot suffix follows the platform of the process driving the run (the host). The server SHALL NOT rewrite, wrap, or patch the project configuration to force a container platform suffix.

#### Scenario: Project template drives baseline targets

- **WHEN** a project declares `snapshotPathTemplate` and a docker-mode run resolves baseline targets
- **THEN** passed-baseline display and approval writes use that template for that project's tests

#### Scenario: Native suffix on non-Linux hosts

- **WHEN** docker mode runs on a host platform other than linux and the project declares no template
- **THEN** resolved baseline names carry the host platform suffix, matching what Playwright itself looks for during the run

### Requirement: Docker-mode Playwright refusal and sidecar status

Explicit docker mode SHALL refuse a Playwright run with the `docker-unavailable` reason when the sidecar cannot be ensured (daemon unreachable, image pull failure, or readiness timeout) or when the declared browser pin preflight rejects the resolved sidecar image; in every refusal no `playwright test` process SHALL spawn. Sidecar preparation for Playwright runs SHALL broadcast the same run-status preparation phases as Vitest sidecar runs (probe, pull, sidecar start, readiness), and the live UI SHALL report the run as docker mode.

#### Scenario: Sidecar unavailable refuses the run

- **WHEN** the server runs with `--run-mode docker`, a Playwright run is requested, and the daemon is down or the sidecar fails to start
- **THEN** the run request fails with the `docker-unavailable` reason and no test process spawns

#### Scenario: Pin drift refuses before the container starts

- **WHEN** a docker-mode Playwright run declares a browser pin that the resolved sidecar image cannot satisfy
- **THEN** the run is refused before the sidecar container starts, with the matching image tag as the remedy

#### Scenario: Preparation phases stream to the live UI

- **WHEN** a docker-mode Playwright run prepares with browsers
- **THEN** run-status messages carry the pull/start phases and the docker mode to connected browsers

### Requirement: Sidecar container configuration

A docker-mode Playwright run SHALL configure the managed sidecar from the docker options: `docker.image` overrides the version-derived image, `docker.platform` selects the container platform, `docker.extraArgs` are appended to the sidecar's `docker run` invocation, and font rendering follows the sidecar's rendering pins. The server SHALL NOT expose an in-container entry-command option for docker-mode Playwright runs.

#### Scenario: Docker options reach the sidecar invocation

- **WHEN** the server is configured with a custom image, a platform, or extra `docker run` arguments
- **THEN** the sidecar container starts with those values for Playwright runs as it already does for Vitest runs
