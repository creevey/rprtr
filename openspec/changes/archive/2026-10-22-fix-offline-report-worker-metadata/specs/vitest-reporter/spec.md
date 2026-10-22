# Spec Delta

## MODIFIED Requirements

### Requirement: CI-mode portable artifacts

When no live server is available (offline/CI mode), the Vitest reporter SHALL copy screenshot artifacts into the screenshot directory under content-addressed file names, reference the copies by relative path in the test events, and write the static HTML report and one offline JSON report per run with the same portability guarantees as Playwright runs. The offline report SHALL record Vitest's resolved `maxWorkers` as its run-level `workers` value.

#### Scenario: Offline Vitest run produces portable artifacts

- **WHEN** a Vitest run completes with no rprtr server running
- **THEN** a schema-valid offline JSON report is written whose attachment paths are relative to the screenshot directory, alongside a static HTML report that renders the Vitest screenshot diffs when opened directly from disk

#### Scenario: Static report renders Vitest images

- **WHEN** the static HTML artifact from an offline Vitest run is opened in a browser next to its screenshot directory
- **THEN** expected, actual, and diff images render from the relative artifact paths without any server

#### Scenario: Offline Vitest report records worker capacity

- **WHEN** an offline Vitest run resolves `maxWorkers` to a value greater than one
- **THEN** the offline report records that resolved value in `workers`

### Requirement: Offline report replay for Vitest runs

The CLI and server artifact-dir mode SHALL load offline reports produced by Vitest runs and merge them into report state with the same rules as Playwright offline reports, preserving images, statuses, and test locations.

#### Scenario: crvy-rprtr loads a Vitest offline report

- **WHEN** `crvy-rprtr <artifact-dir>` starts and the directory contains offline reports written by Vitest runs
- **THEN** the UI shows the Vitest tests with their statuses and screenshot images, indistinguishable in structure from Playwright-reported tests
