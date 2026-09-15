## MODIFIED Requirements

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

## ADDED Requirements

### Requirement: Pre-run Vitest test tree discovery

When the server seeds a Vitest run context at startup, it SHALL populate the live report tree with the project's discovered tests as `pending` entries — without requiring any prior run — by asking the discovered Vitest project to enumerate its tests. The enumerated tree SHALL group tests by test file the same way streamed results do. The CLI SHALL NOT gain new flags for this behavior, and a discovered Playwright project SHALL NOT be listed (Playwright keeps config-seeded buttons with an empty pre-run tree).

#### Scenario: Fresh start in a Vitest Browser Mode project

- **WHEN** the server starts in a directory whose `vitest.config.*` declares browser-mode tests and no report is loaded
- **THEN** the sidebar lists every enumerated test grouped under its test file with `pending` status and the run controls are enabled, before any test has executed

#### Scenario: Discovered entries fill only gaps in a loaded report

- **WHEN** the server loads a persisted report with results for some tests and discovery enumerates a superset of them
- **THEN** tests present in the report keep their recorded results and statuses, and only test identities absent from the report appear as `pending`

#### Scenario: A real run replaces discovered entries

- **WHEN** a Vitest run streams results after discovery seeded the tree
- **THEN** the streamed events fully replace the discovered `pending` entries, and tests deleted from the project between discovery and the run disappear from the tree

#### Scenario: Discovered pending tests are not persisted

- **WHEN** the server saves its report state after discovery seeded `pending` entries that never ran
- **THEN** the persisted report (and, through it, offline JSON review and the static HTML artifact) contains no trace of the never-run `pending` entries

#### Scenario: Static and offline surfaces stay event-derived

- **WHEN** discovery seeds `pending` entries and the server later produces offline reports or the static HTML artifact
- **THEN** those artifacts remain derived from actual run events only and show no discovered-but-never-run tests
