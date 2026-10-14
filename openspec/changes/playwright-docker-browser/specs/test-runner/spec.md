# Spec Delta

## ADDED Requirements

### Requirement: Docker mode routes Playwright runs through the browser sidecar

In explicit docker run mode, a Playwright run request SHALL launch the local Playwright CLI with the managed browser sidecar connection injected, and SHALL fail fast with the `docker-unavailable` reason when the sidecar cannot be ensured. In auto run mode resolved to a reachable daemon, a Playwright run SHALL use the sidecar. In local run mode, a Playwright run SHALL launch locally with no sidecar interaction. Unlike the Vitest path, a Playwright run SHALL NOT require or scan for a config hook.

#### Scenario: Explicit docker mode uses the sidecar

- **WHEN** the server runs with `--run-mode docker`, a Playwright run is requested, and the daemon is reachable
- **THEN** the run launches the local Playwright CLI with the sidecar connection injected and no config hook is required

#### Scenario: Explicit docker mode with the daemon down

- **WHEN** the server runs with `--run-mode docker`, a Playwright run is requested, and no daemon is reachable
- **THEN** the request fails with the `docker-unavailable` reason and no test process spawns

#### Scenario: Auto mode with a reachable daemon uses the sidecar

- **WHEN** the server runs in auto mode, a Docker daemon is reachable, and a Playwright run is requested
- **THEN** the run launches with the sidecar connection injected

#### Scenario: Local mode never touches the sidecar

- **WHEN** the server runs with `--run-mode local` and a Playwright run is requested
- **THEN** the run launches locally with no sidecar container interaction

## MODIFIED Requirements

### Requirement: Run status reflects the sidecar mode and preparation phases

UI-launched sidecar-backed runs SHALL broadcast the docker run mode with preparation phases (probe, pull, sidecar start, readiness) on the existing run-status channel for both the Playwright and Vitest runners, so the live UI shows the docker mode indication whenever a run uses the sidecar.

#### Scenario: Live UI shows docker mode for a sidecar run

- **WHEN** a sidecar-backed Playwright or Vitest run starts streaming to the live UI
- **THEN** run-status messages report the docker mode and the preparation phases that occurred
