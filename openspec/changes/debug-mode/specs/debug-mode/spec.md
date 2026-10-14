# Spec Delta

## Purpose

An opt-in diagnostic mode for the rprtr server and reporters: one switch that records what a run launched, mirrors output that would otherwise be swallowed, and preserves failed containers for inspection — without changing run behavior, results, or artifacts.

## ADDED Requirements

### Requirement: Debug mode activation and propagation

Debug mode SHALL be enabled by the `--debug` CLI flag, by `ServerOptions.debug`, or by a non-empty `CRVY_RPRTR_DEBUG` environment variable. A non-empty `DEBUG` alone SHALL NOT enable server-side debug records or container retention. When debug mode is enabled, the server SHALL ensure `CRVY_RPRTR_DEBUG` is present in the environment of every process it spawns — runs, test listings, and containers — regardless of how debug mode was activated. Reporter-side debug logging SHALL be enabled by `CRVY_RPRTR_DEBUG` or a non-empty `DEBUG`, preserving the existing legacy behavior. With debug mode disabled, no debug records SHALL be produced.

#### Scenario: Flag enables debug for the whole path

- **WHEN** the server is started with `--debug` (or `ServerOptions.debug`) and a run is launched
- **THEN** debug records are emitted and the spawned run, listings, and container carry `CRVY_RPRTR_DEBUG`

#### Scenario: Environment variable enables debug

- **WHEN** `CRVY_RPRTR_DEBUG` is set and no flag is given
- **THEN** debug mode is enabled without a CLI flag or programmatic option

#### Scenario: Playwright's DEBUG does not enable server debug

- **WHEN** only `DEBUG` is set — for example `DEBUG=pw:webserver`
- **THEN** server-side debug records and container retention stay off while reporter-side logging keeps its legacy `DEBUG` behavior

#### Scenario: Reporter debug without a server

- **WHEN** a reporter runs under a plain test-runner invocation with `CRVY_RPRTR_DEBUG` set and no rprtr server reachable
- **THEN** the reporter's debug lines appear on the run's terminal

### Requirement: Debug launch records

With debug mode enabled, every run launch SHALL record the exact command and its arguments. The record SHALL name the environment variables present in the child's launch environment and SHALL include their values only for a fixed, documented allowlist of runner and tooling controls. Whenever a container is involved, the record SHALL additionally name the resolved image, the container name, the platform when one is pinned, and every bind-mount source together with whether that source existed at launch. This SHALL hold for Playwright and Vitest runs alike.

#### Scenario: Command vector recorded

- **WHEN** a debug-mode run is launched
- **THEN** its record contains the exact spawned command and arguments

#### Scenario: Environment names and allowlisted values

- **WHEN** a debug-mode run is launched with environment variables such as `CI`, `DEBUG`, and `NODE_OPTIONS` present
- **THEN** their names are recorded, allowlisted ones also carry values, and no other variable's value appears

#### Scenario: Container launch details recorded

- **WHEN** a debug-mode launch involves a container
- **THEN** the record names the image, container name, pinned platform when present, and each bind-mount source with its existence at launch

#### Scenario: Missing mount source is visible before the run dies

- **WHEN** a bind-mount source does not exist on the host at launch
- **THEN** the debug record marks that source as missing, so a container that starts and exits immediately is attributable

### Requirement: Debug records for preparation and listings

With debug mode enabled, container preparation SHALL record each phase — daemon probe, image pull, sidecar start, readiness — with its start and completion. A failing test listing SHALL record the listing command, the failure reason, and a bounded excerpt of the listing's stderr.

#### Scenario: Preparation phases are timed

- **WHEN** a debug-mode docker run prepares its image and sidecar
- **THEN** the debug output shows each preparation phase with its timing

#### Scenario: Listing failure explains itself

- **WHEN** a discovery or pin-preflight listing fails in debug mode
- **THEN** the record names the command, the failure reason, and a bounded stderr excerpt

### Requirement: Child output capture in debug mode

With debug mode enabled, a run's child process SHALL be spawned with its output captured and mirrored to the server terminal with per-stream prefixes, so output is observable even when the server's own stdout is a pipe or otherwise swallowed. A child that writes nothing SHALL be recorded as having written nothing.

#### Scenario: Swallowed output becomes visible

- **WHEN** the server runs under a `webServer`-style pipe or a daemon and a debug-mode run writes output
- **THEN** the output appears on the server terminal with stream prefixes

#### Scenario: Silent child is explicit

- **WHEN** a debug-mode run's child exits without writing to either stream
- **THEN** the debug output states that the child wrote nothing

### Requirement: Failed-container retention in debug mode

With debug mode enabled, a container that fails or exits non-zero SHALL be retained for inspection instead of being removed: the server SHALL label retained containers, record the `docker logs` and `docker inspect` commands for them, and remove a stale retained container before a new launch that would reuse its name. With debug mode disabled, container cleanup SHALL be unchanged except for the sidecar failure-evidence requirement.

#### Scenario: Failed container is retained with inspection commands

- **WHEN** a debug-mode run's container exits non-zero
- **THEN** the container is left in place, labeled, and its `docker logs`/`docker inspect` commands are recorded

#### Scenario: Retained container does not block the next run

- **WHEN** a new debug-mode launch would reuse the name of a retained container
- **THEN** the stale retained container is removed before the launch

#### Scenario: Debug off keeps cleanup unchanged

- **WHEN** debug mode is disabled and a run's container exits non-zero
- **THEN** the container is removed exactly as before this capability

### Requirement: Debug records are redacted and terminal-only

Debug records SHALL never include environment values outside the allowlist, values whose names suggest credentials or tokens, or token-bearing URLs. Records SHALL be terminal-only: they SHALL NOT enter `report.json`, offline JSON reports, or the static HTML artifact, and SHALL NOT be sent to connected live browsers. Enabling debug mode SHALL NOT change run outcomes, selections, or refusal reasons.

#### Scenario: Credential-shaped values never appear

- **WHEN** a debug-mode run environment contains a variable such as `GITHUB_TOKEN` or `NPM_TOKEN`
- **THEN** neither its value nor a token-bearing URL form of it appears in any debug record

#### Scenario: Artifacts and UI stay event-derived

- **WHEN** debug mode is enabled and records are emitted
- **THEN** `report.json`, offline JSON reports, and the static HTML artifact contain only event-derived data, and no record content is sent over the live WebSocket channel

#### Scenario: Debugging changes no outcomes

- **WHEN** the same run request is executed with debug mode on and off
- **THEN** the selection, results, and any refusal reason are identical
