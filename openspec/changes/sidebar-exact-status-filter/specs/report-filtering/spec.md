# Spec Delta

## Purpose

Defines which tests and suites the report sidebar exposes when a reviewer filters by test status or by title text, consistently across the live server UI, offline replay, and the static HTML artifact.

## ADDED Requirements

### Requirement: Status filters match test status exactly, except running tests under failed

The report UI SHALL apply a status filter as exact equality against each test's report status. A test SHALL be visible under `status:<status>` only when its status equals the requested status. The single exception is `status:failed`, which SHALL also keep tests with status `running` visible so a failed-test rerun stays in view until it settles. The filter SHALL NOT include pending, retrying, or unknown tests when the requested status is `failed`.

#### Scenario: Failed excludes skipped tests

- **WHEN** the sidebar filter is `status:failed` and a test was skipped, so its report status is `pending`
- **THEN** the skipped test is not visible in the filtered sidebar
- **AND** failed tests remain visible

#### Scenario: Failed excludes discovered tests

- **WHEN** the sidebar filter is `status:failed` and a discovered test has never run, so its report status is `pending`
- **THEN** the discovered test is not visible in the filtered sidebar

#### Scenario: Failed keeps a rerun in view until it settles

- **WHEN** the sidebar filter is `status:failed` and a failed test is rerun, so its report status becomes `running`
- **THEN** the running test remains visible in the filtered sidebar
- **AND** it stays visible when it fails again
- **AND** it leaves the filtered sidebar when it passes

#### Scenario: Running tests do not leak into other status filters

- **WHEN** the sidebar filter is `status:pending`, `status:success`, or `status:approved` and a test has status `running`
- **THEN** the running test is not visible under that filter

#### Scenario: Pending includes skipped and never-run tests

- **WHEN** the sidebar filter is `status:pending`
- **THEN** skipped tests are visible because their report status is `pending`
- **AND** discovered but never-run tests are visible because their report status is also `pending`

#### Scenario: Success and approved are exact

- **WHEN** the sidebar filter is `status:success` or `status:approved`
- **THEN** only tests whose report status equals that value are visible
- **AND** approved tests are not shown under `status:success`, and successful tests are not shown under `status:approved`

### Requirement: Filtering preserves the suite hierarchy around matches

The report UI SHALL keep a suite visible only when at least one descendant test matches the active filter. It SHALL preserve the ancestor chain needed to reach every match and SHALL omit suites with no matching descendants. A matching suite title SHALL continue to expose its descendants when the filter contains no status token.

#### Scenario: Only matching branches remain

- **WHEN** a top-level group contains one matching test in a nested suite and one non-matching sibling suite
- **THEN** the filtered tree shows the ancestor chain to the matching test
- **AND** the non-matching sibling suite is omitted

#### Scenario: Empty group is omitted

- **WHEN** no descendant test of a group matches the active filter
- **THEN** the group is not rendered in the filtered tree

#### Scenario: Matching suite title retains descendants

- **WHEN** a text-only filter matches a suite title
- **THEN** that suite is visible with its descendants, preserving the current title-match behavior

### Requirement: Filtering is view-only

Applying, changing, or clearing a filter SHALL NOT mutate test statuses, results, approvals, suite status rollups, run state, or persisted report data. The filter SHALL be a client-side view over the loaded report.

#### Scenario: Report data is unchanged after filtering

- **WHEN** a reviewer applies `status:failed` and then clears it
- **THEN** every test keeps its prior status, results, and approval state
- **AND** `report.json`, offline JSON reports, and the static artifact data are unchanged

#### Scenario: Status counts remain report-wide

- **WHEN** a status filter is active
- **THEN** the sidebar status counts continue to describe the full loaded report rather than the filtered subset

### Requirement: Filter behavior is identical across report surfaces

The live server UI, offline replay, and the static `crvy-rprtr.html` artifact SHALL apply the same status and text filter semantics to the same report data. The CLI SHALL NOT gain or change filtering behavior, and no filter state SHALL be persisted into report artifacts.

#### Scenario: Static artifact matches the live UI

- **WHEN** the same report containing failed, skipped/pending, and running tests is filtered by `status:failed` in the live UI and in the static artifact
- **THEN** both surfaces show only the failed tests and the suites needed to reach them

#### Scenario: Offline replay matches the live UI

- **WHEN** an offline report is replayed and the reviewer applies a status filter
- **THEN** the visible tests and suites match what the live UI would show for the same report data

#### Scenario: CLI output is unaffected

- **WHEN** a reviewer filters the sidebar while the CLI serves an artifact directory
- **THEN** no filtered test list or filter state is written to the report or printed as a CLI result
