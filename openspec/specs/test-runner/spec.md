# test-runner Specification

## Purpose

Lets users re-run tests from the crvy-rprtr UI for any supported test runner — Playwright today, Vitest Browser Mode added by this change — by defining how the server learns which runner kind to launch and how run options (update mode, per-test filters) map to each runner's CLI.

## Requirements

### Requirement: Runner registration enables UI run triggering

The server SHALL treat a register payload carrying `configFile`, `cwd`, and `runner` as a runnable run context, enabling the sidebar run controls. The server SHALL NOT enable run triggering from a register payload missing `configFile` or `cwd`. When `runner` is absent, the server SHALL resolve the runner kind to Playwright.

#### Scenario: Playwright register keeps enabling run buttons

- **WHEN** a Playwright reporter registers with `configFile` and `cwd` and no `runner` field
- **THEN** the run controls are enabled and the runner kind resolves to Playwright

#### Scenario: Vitest register enables run buttons

- **WHEN** a Vitest reporter registers with `configFile`, `cwd`, and `runner: 'vitest'`
- **THEN** the run controls are enabled and the runner kind resolves to Vitest

#### Scenario: Old Vitest reporter stays button-less

- **WHEN** a Vitest reporter predating this change registers with only artifact-directory fields
- **THEN** the run controls remain hidden and run requests fail with `no-config`

#### Scenario: Run request before any registration

- **WHEN** a run is requested before any reporter registered a run context and no Vitest config was discovered at startup
- **THEN** the response fails with the `no-config` reason

#### Scenario: Startup discovery accepts Playwright and Vitest configs

- **WHEN** the server starts without a registering reporter and discovers a config in its working directory, or is started with the CLI `--config` flag
- **THEN** a discovered or configured `playwright.config.*` seeds a Playwright run context exactly as before, and a discovered `vitest.config.*` seeds a Vitest run context (`runner: 'vitest'`) whose run controls are enabled before any run

#### Scenario: Discovered Vitest config with a failing test listing

- **WHEN** a `vitest.config.*` is discovered but spawning the Vitest test listing fails (broken config, missing dependencies, no tests)
- **THEN** the run controls are still enabled from the discovered config, the sidebar keeps whatever a loaded report provides, and the server logs the listing failure without crashing

### Requirement: Vitest reporter declares its runner

The Vitest reporter SHALL include `configFile`, `cwd` (the Vitest project root), and `runner: 'vitest'` in its register payload whenever the running configuration exposes a config file path. Register payloads from CI mode SHALL remain unchanged (no register is sent when the reporter runs in CI mode).

#### Scenario: Reporter registers from a config file

- **WHEN** Vitest runs with a `vitest.config.*` file and browser mode initializes against a live server
- **THEN** the register payload carries that config path, the project root as `cwd`, and `runner: 'vitest'`

#### Scenario: Inline configuration without a config file

- **WHEN** Vitest runs without a config file (programmatic inline configuration)
- **THEN** the register payload omits `configFile` and the run controls stay hidden

### Requirement: Runner-appropriate launch commands

The server SHALL launch the registered runner kind with its own CLI, resolved through the project's package manager: `playwright test --config <configFile>` for Playwright and `vitest run --config <configFile>` for Vitest. A run request with update enabled SHALL pass `--update-snapshots` to Playwright and `--update` to Vitest.

#### Scenario: Full-suite Playwright run

- **WHEN** a run is requested with no test filters on a Playwright-registered project
- **THEN** the server spawns the package manager's `playwright test --config <configFile>` with the rprtr reporter injected

#### Scenario: Full-suite Vitest run

- **WHEN** a run is requested with no test filters on a Vitest-registered project
- **THEN** the server spawns the package manager's `vitest run --config <configFile>` without injecting a reporter (the project's Vitest config already carries one)

#### Scenario: Update run per provider

- **WHEN** a run is requested with update enabled
- **THEN** the spawned command carries the registered runner's update flag

### Requirement: Per-test filtering maps to each runner's selection flags

The server SHALL translate per-test run requests using the registered runner's selection flags. Playwright keeps its positional `file:line[:column]` filters, shared `--project`, and version-gated `--test-list`. Vitest SHALL select by test file (positional filter), by `--project` when all requested tests share one project, and by `-t` with a pattern built from the tests' full title path.

#### Scenario: Single Vitest test re-run

- **WHEN** a run is requested for one Vitest test with title path `['renders', 'primary button']` in file `tests/button.test.ts`
- **THEN** the spawned command contains the file `tests/button.test.ts` and `-t` with a pattern built from that title path

#### Scenario: Playwright per-test behavior unchanged

- **WHEN** a run is requested for Playwright tests
- **THEN** the server uses the existing positional/`--test-list` selection unchanged

### Requirement: Launched Vitest runs stream into the live UI

A UI-launched run SHALL spawn with the server URL injected (`CRVY_RPRTR_SERVER_URL`) and the `CI` variable removed, so results stream to the live UI instead of writing offline artifacts. Locally launched runs SHALL receive the same deterministic text-rendering environment regardless of runner kind (grayscale fontconfig on Linux, no-op elsewhere).

#### Scenario: Live streaming of a UI-launched Vitest run

- **WHEN** the server spawns `vitest run` for a Vitest-registered project whose reporter does not pin an explicit `serverUrl`
- **THEN** the spawned environment carries the server's WebSocket URL without `CI`, the UI shows tests updating live, and the run is reported as running until the process exits

#### Scenario: Deterministic env for Vitest launches

- **WHEN** a Vitest run is launched locally on Linux with default font rendering
- **THEN** the spawned process environment carries the same grayscale fontconfig override a Playwright launch receives

### Requirement: Pre-run test tree discovery

When the server seeds a run context at startup, it SHALL populate the live report tree with the project's discovered tests as `pending` entries — without requiring any prior run — by asking the discovered project to enumerate its tests. Vitest and Playwright run contexts SHALL both be enumerated through the project's own test listing, which SHALL be a collection pass that executes no tests. The enumerated tree SHALL group tests by test file and label them with the browser label streamed results use, so a test's sidebar slot is the same before and during a run. The CLI SHALL NOT gain new flags for this behavior, and a listing that fails SHALL NOT disable the run controls or clear a loaded report.

#### Scenario: Fresh start in a Vitest Browser Mode project

- **WHEN** the server starts in a directory whose `vitest.config.*` declares browser-mode tests and no report is loaded
- **THEN** the sidebar lists every enumerated test grouped under its test file with `pending` status and the run controls are enabled, before any test has executed

#### Scenario: Fresh start in a Playwright project

- **WHEN** the server starts in a directory whose `playwright.config.*` declares tests and no report is loaded
- **THEN** the sidebar lists every enumerated test grouped under its test file with `pending` status and the run controls are enabled, before any test has executed

#### Scenario: Playwright entries occupy the same tree slots as streamed results

- **WHEN** a Playwright project with describe blocks and multiple named projects is listed before a run
- **THEN** each enumerated test appears under the same file tokens, describe title path, and browser label its streamed result uses

#### Scenario: A failing Playwright listing keeps the controls and the loaded report

- **WHEN** a `playwright.config.*` is discovered but spawning the Playwright listing fails (broken config, missing dependencies, no tests, timeout)
- **THEN** the run controls stay enabled, the sidebar keeps whatever a loaded report provides, and the server logs the listing failure without crashing

#### Scenario: Discovered entries fill only gaps in a loaded report

- **WHEN** the server loads a persisted report with results for some tests and discovery enumerates a superset of them
- **THEN** tests present in the report keep their recorded results and statuses, and only test identities absent from the report appear as `pending`

#### Scenario: A real run replaces discovered entries

- **WHEN** a run streams results after discovery seeded the tree
- **THEN** the streamed events fully replace the discovered `pending` entries, and tests deleted from the project between discovery and the run disappear from the tree

#### Scenario: Discovered pending tests are not persisted

- **WHEN** the server saves its report state after discovery seeded `pending` entries that never ran
- **THEN** the persisted report (and, through it, offline JSON review and the static HTML artifact) contains no trace of the never-run `pending` entries

#### Scenario: Static and offline surfaces stay event-derived

- **WHEN** discovery seeds `pending` entries and the server later produces offline reports or the static HTML artifact
- **THEN** those artifacts remain derived from actual run events only and show no discovered-but-never-run tests

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
