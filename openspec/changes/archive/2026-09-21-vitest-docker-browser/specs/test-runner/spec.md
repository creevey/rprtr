## REMOVED Requirements

### Requirement: Docker mode applies to Playwright runs only

**Reason**: Superseded by the browser-sidecar run mode; Vitest runs now have a docker-mode launch path (local vitest + managed sidecar) instead of a blanket refusal.
**Migration**: Explicit docker mode no longer refuses Vitest runs categorically — it refuses only when the project's Vitest config lacks the documented browser-endpoint hook (`docker-missing-browser-hook`); auto mode behavior is preserved for that case.

## ADDED Requirements

### Requirement: Docker mode routes Vitest runs through the browser sidecar

In explicit docker run mode, a Vitest run request SHALL launch local vitest with the browser sidecar endpoint injected when the project's Vitest config references the documented browser-endpoint environment variable, and SHALL fail fast with the `docker-missing-browser-hook` reason when it does not. In auto run mode with a reachable daemon, a Vitest run SHALL use the sidecar when the hook is present and SHALL launch locally with a single warning when it is absent. In local run mode, a Vitest run SHALL launch locally with no sidecar interaction.

#### Scenario: Explicit docker mode with the config hook

- **WHEN** the server runs with `--run-mode docker`, a Vitest run is requested, and the Vitest config references the browser-endpoint environment variable
- **THEN** vitest launches locally with the sidecar endpoint injected and no refusal occurs

#### Scenario: Explicit docker mode without the config hook

- **WHEN** the server runs with `--run-mode docker` and a Vitest run is requested whose config does not reference the browser-endpoint environment variable
- **THEN** the request fails with the `docker-missing-browser-hook` reason, no vitest process spawns, and no sidecar is started

#### Scenario: Auto mode without the hook falls back to local

- **WHEN** the server runs in auto mode, a Docker daemon is reachable, a Vitest run is requested, and the config lacks the hook
- **THEN** the run launches locally and the server logs one warning

#### Scenario: Auto mode with the hook uses the sidecar

- **WHEN** the server runs in auto mode, a Docker daemon is reachable, a Vitest run is requested, and the config references the browser-endpoint environment variable
- **THEN** the run launches with the sidecar endpoint injected

#### Scenario: Local mode never touches the sidecar

- **WHEN** the server runs with `--run-mode local` and a Vitest run is requested
- **THEN** the run launches locally with no sidecar container interaction

### Requirement: Run status reflects the sidecar mode and preparation phases

UI-launched sidecar Vitest runs SHALL broadcast the docker run mode with preparation phases (probe, pull, sidecar start, readiness) on the existing run-status channel, so the live UI shows the same mode indication as Playwright docker runs.

#### Scenario: Live UI shows docker mode for a sidecar run

- **WHEN** a sidecar-assisted Vitest run starts streaming to the live UI
- **THEN** run-status messages report the docker mode and the preparation phases that occurred
