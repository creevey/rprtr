# vitest-reporter — Delta Spec

## ADDED Requirements

### Requirement: Vitest run event stream

The system SHALL accept test lifecycle events (`test-begin`, `test-end`, `run-end`) emitted by a Vitest Browser Mode run and maintain report state from them exactly as it does for Playwright events. Each Vitest event SHALL identify the source test module location, the test title path, and the browser name resolved from the Vitest project configuration.

#### Scenario: Vitest browser test streams live events

- **WHEN** a Vitest Browser Mode run executes a screenshot test against a running rprtr server
- **THEN** the server receives `test-begin` when the test case starts, `test-end` with the mapped status (`passed`/`failed`/`skipped`) when it finishes, and `run-end` when the run completes
- **AND** the live UI lists the test under its Vitest title path and browser name

#### Scenario: Skipped and pending Vitest tests

- **WHEN** a Vitest test case is skipped or pending
- **THEN** the corresponding report state maps to the same status the UI renders for skipped Playwright tests

### Requirement: Screenshot artifact normalization

The system SHALL convert Vitest `toMatchScreenshot` test artifacts into the rprtr image model: a `reference` artifact maps to the expected image, `actual` and `diff` artifacts map to their roles, grouped per screenshot name derived from the artifact file names. When only a reference exists (first run), the image SHALL surface as baseline-only with no actual or diff image.

#### Scenario: Failed comparison produces all three roles

- **WHEN** a Vitest screenshot assertion fails with reference, actual, and diff artifacts
- **THEN** the reported test result contains one image entry named after the screenshot with expected, actual, and diff images

#### Scenario: First run with no existing reference

- **WHEN** a Vitest screenshot assertion runs for the first time and vitest records a new reference
- **THEN** the reported image contains only the expected image and is classified as baseline-only

### Requirement: Dev-mode zero-copy artifact serving

In dev mode (live server), the Vitest reporter SHALL report Vitest's native artifact file paths without copying them, using attachment entries named to the rprtr image-role convention. The server SHALL serve these paths over its existing absolute-path file route, and SHALL restrict serving to registered artifact directories.

#### Scenario: Server allowlists registered Vitest directories

- **WHEN** the Vitest reporter registers with the server, reporting its reference and attachment directories
- **THEN** files under those directories are served, and files outside every registered artifact root are rejected

#### Scenario: Failed comparison is viewable without reporter-side copies

- **WHEN** a failed Vitest comparison's artifacts are reported with native absolute paths
- **THEN** the UI displays expected, actual, and diff images fetched from the artifact locations on disk

### Requirement: CI-mode portable artifacts

When no live server is available (offline/CI mode), the Vitest reporter SHALL copy screenshot artifacts into the screenshot directory under content-addressed file names, reference the copies by relative path in the test events, and write the static HTML report and per-worker offline JSON reports with the same portability guarantees as Playwright runs.

#### Scenario: Offline Vitest run produces portable artifacts

- **WHEN** a Vitest run completes with no rprtr server running
- **THEN** a schema-valid offline JSON report is written whose attachment paths are relative to the screenshot directory, alongside a static HTML report that renders the Vitest screenshot diffs when opened directly from disk

#### Scenario: Static report renders Vitest images

- **WHEN** the static HTML artifact from an offline Vitest run is opened in a browser next to its screenshot directory
- **THEN** expected, actual, and diff images render from the relative artifact paths without any server

### Requirement: Offline report replay for Vitest runs

The CLI and server artifact-dir mode SHALL load per-worker offline reports produced by Vitest runs and merge them into report state with the same rules as Playwright offline reports, preserving images, statuses, and test locations.

#### Scenario: crvy-rprtr loads a Vitest offline report

- **WHEN** `crvy-rprtr <artifact-dir>` starts and the directory contains offline reports written by Vitest runs
- **THEN** the UI shows the Vitest tests with their statuses and screenshot images, indistinguishable in structure from Playwright-reported tests

### Requirement: Vitest screenshot layout configuration

The Vitest reporter SHALL resolve reference and artifact locations from Vitest's default directory layout, and SHALL accept explicit reference-directory and attachment-directory options that override the defaults. Custom Vitest path-resolver callbacks are not supported and MUST be rejected or reported as unsupported when detected.

#### Scenario: Default layout resolution

- **WHEN** a Vitest run uses the default screenshot directories
- **THEN** the reporter locates references under the test file's default reference directory and artifacts under the default attachments directory without extra configuration

#### Scenario: Explicit directory overrides

- **WHEN** the reporter is configured with explicit reference and attachment directories
- **THEN** reference and artifact resolution and the registered allowlist roots use the configured directories
