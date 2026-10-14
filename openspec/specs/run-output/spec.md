# run-output Specification

## Purpose

Keeps the runner's own terminal output and fatal error reports visible when crvy-rprtr is the only configured reporter, so a failure outside a test body — a `webServer` command exiting early, a broken configuration, a global setup failure — stays diagnosable from the terminal that launched the run.

## Requirements

### Requirement: Runner error and process output passthrough

The Playwright reporter SHALL forward the runner's fatal error reports and process output to the terminal: every error SHALL be written to stderr in a form that names the failure, and every runner stdout/stderr chunk — including `webServer` process output and test-attached output — SHALL be written to the matching stream. This keeps a run diagnosable when crvy-rprtr is the only configured reporter. Passthrough SHALL be independent of CI mode and of live-server connectivity, and SHALL NOT alter test results, report state, offline JSON reports, or the static HTML artifact.

#### Scenario: Fatal error reaches the terminal

- **WHEN** a server-launched Playwright run fails before any test executes — for example the `webServer` command exits early — and the crvy-rprtr reporter is the only reporter
- **THEN** the server terminal shows the runner's error naming the failure

#### Scenario: webServer process output reaches the terminal

- **WHEN** a `webServer` command writes to stdout or stderr while it starts
- **THEN** that output appears on the matching terminal stream

#### Scenario: Test-attached output reaches the terminal

- **WHEN** a test writes to stdout or stderr through the runner
- **THEN** the output appears on the matching terminal stream

#### Scenario: Offline and CI runs forward the same way

- **WHEN** the reporter runs in CI or offline mode with no live server reachable
- **THEN** fatal errors and process output are still written to the terminal

#### Scenario: Artifacts stay event-derived

- **WHEN** a run forwards errors and process output and then writes offline JSON reports or the static HTML artifact
- **THEN** those artifacts contain the run's events and no forwarded terminal output

### Requirement: Run launch record

Before a UI-launched run's child process is spawned, the server SHALL record one launch line on the server terminal naming the execution mode (local or docker), the runner kind, the working directory, the configuration file, the selection size and update flag, and — whenever a container is involved — the resolved docker image and container name. The record SHALL be produced for Playwright and Vitest runs alike, regardless of how the server was started or whether browsers are connected, and SHALL NOT contain environment variable values or command arguments.

#### Scenario: Local run launch record

- **WHEN** a UI-launched local-mode run spawns
- **THEN** the terminal shows one launch record naming local mode, the runner kind, the working directory, the configuration file, and the selection size

#### Scenario: Docker run launch record

- **WHEN** a UI-launched docker-mode run spawns
- **THEN** the launch record additionally names the resolved docker image and the container name

#### Scenario: Filtered and update runs are distinguishable

- **WHEN** a run is requested for a subset of tests with update enabled
- **THEN** the launch record carries the selection size and marks update mode

### Requirement: Run exit record

When a UI-launched run's child process settles, the server SHALL record an exit line on the server terminal naming the exit code or the terminating signal and the elapsed run duration. A non-zero termination SHALL remain visible as a warning naming the exit code or signal, and a zero exit SHALL still be recorded so every run's duration is observable.

#### Scenario: Failed run exit

- **WHEN** a UI-launched run's child exits with a non-zero code
- **THEN** the terminal shows a warning naming the code and the elapsed duration

#### Scenario: Signal termination

- **WHEN** a run is stopped and its child terminates on a signal — the SIGTERM grace path or the SIGKILL escalation
- **THEN** the exit record names the signal and the elapsed duration instead of a numeric code

#### Scenario: Successful run exit

- **WHEN** a UI-launched run's child exits with code 0
- **THEN** the exit record shows the zero exit and the elapsed duration

### Requirement: Launch and exit records stay out of artifacts

Launch and exit records SHALL be terminal-only: they SHALL NOT alter or appear in `report.json`, offline JSON reports, or the static HTML artifact, and SHALL NOT be forwarded to connected live browsers.

#### Scenario: Artifacts stay event-derived

- **WHEN** a run is launched and exits with records emitted
- **THEN** `report.json`, offline JSON reports, and the static HTML artifact contain only event-derived data with no record content

#### Scenario: Live UI stays unchanged

- **WHEN** browsers are connected while records are emitted
- **THEN** no record content is sent over the live WebSocket channel
