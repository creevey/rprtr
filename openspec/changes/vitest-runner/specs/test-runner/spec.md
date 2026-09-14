## Purpose

Lets users re-run tests from the crvy-rprtr UI for any supported test runner — Playwright today, Vitest Browser Mode added by this change — by defining how the server learns which runner kind to launch and how run options (update mode, per-test filters) map to each runner's CLI.

## ADDED Requirements

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

- **WHEN** a run is requested before any reporter registered a run context
- **THEN** the response fails with the `no-config` reason

#### Scenario: Startup discovery remains Playwright-only

- **WHEN** the server starts without a registering reporter and discovers a config in its working directory, or is started with the CLI `--config` flag
- **THEN** only Playwright configs are discovered/accepted and the seeded run context resolves to the Playwright runner

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

### Requirement: Docker mode applies to Playwright runs only

In explicit docker run mode, a Vitest run request SHALL fail fast with a dedicated docker-unsupported failure reason instead of launching a container. In auto run mode with a reachable daemon, a Vitest run request SHALL launch locally with a single warning. In local run mode, a Vitest run request SHALL launch locally.

#### Scenario: Explicit docker mode refuses Vitest runs

- **WHEN** the server runs with `--run-mode docker` and a Vitest run is requested
- **THEN** the request fails with a docker-unsupported reason and no process spawns

#### Scenario: Auto mode falls back to local for Vitest

- **WHEN** the server runs with default auto mode, a Docker daemon is reachable, and a Vitest run is requested
- **THEN** the run launches locally and the server logs one warning

### Requirement: Launched Vitest runs stream into the live UI

A UI-launched run SHALL spawn with the server URL injected (`CRVY_RPRTR_SERVER_URL`) and the `CI` variable removed, so results stream to the live UI instead of writing offline artifacts. Locally launched runs SHALL receive the same deterministic text-rendering environment regardless of runner kind (grayscale fontconfig on Linux, no-op elsewhere).

#### Scenario: Live streaming of a UI-launched Vitest run

- **WHEN** the server spawns `vitest run` for a Vitest-registered project whose reporter does not pin an explicit `serverUrl`
- **THEN** the spawned environment carries the server's WebSocket URL without `CI`, the UI shows tests updating live, and the run is reported as running until the process exits

#### Scenario: Deterministic env for Vitest launches

- **WHEN** a Vitest run is launched locally on Linux with default font rendering
- **THEN** the spawned process environment carries the same grayscale fontconfig override a Playwright launch receives
