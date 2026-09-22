# Spec Delta: test-runner

## RENAMED Requirements

- FROM: `### Requirement: Pre-run Vitest test tree discovery`
- TO: `### Requirement: Pre-run test tree discovery`

## MODIFIED Requirements

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
