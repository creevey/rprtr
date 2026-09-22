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
