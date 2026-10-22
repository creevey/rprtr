# report-status-rollup Specification

## Purpose

Defines how descendant test statuses aggregate into a sidebar group's status so failed groups remain distinguishable regardless of skipped, pending, or in-flight siblings, on the live UI, offline replay, and the static HTML artifact.

## Requirements

### Requirement: Group status uses failure-first precedence

The report UI SHALL derive a group's status from all descendant test statuses using one deterministic precedence order, independent of child insertion order, event arrival order, or the number of nested suites. The precedence SHALL be: `failed`, then `running`, then `retrying`, then `pending`, then `approved`, then `success`, then `unknown`. A group with no descendant status SHALL have no status.

A group containing at least one failed descendant SHALL be shown as failed regardless of any skipped/pending, running, approved, successful, or unknown descendants.

#### Scenario: Failed plus skipped is failed

- **WHEN** a group contains one failed test and one skipped test whose report status is `pending`
- **THEN** the group's status is `failed` and its sidebar dot is red
- **AND** the result is the same whether the failed or the skipped test appears first

#### Scenario: Failed plus running is failed

- **WHEN** a group contains one failed test and one test that is still running
- **THEN** the group's status is `failed`

#### Scenario: Failure propagates through nested groups

- **WHEN** a failed test sits inside a nested group whose sibling descendants are skipped/pending or successful
- **THEN** every ancestor group up to the sidebar root is `failed`

#### Scenario: Strongest non-failure status wins

- **WHEN** a group has no failed descendant and contains running and skipped/pending tests
- **THEN** the group's status is `running`
- **AND** without running tests, a group containing skipped/pending and successful tests is `pending`
- **AND** without pending tests, a group containing approved and successful tests is `approved`
- **AND** a group whose descendants are all successful is `success`

#### Scenario: Empty group has no status

- **WHEN** a group has no descendants or none of its descendants has a status
- **THEN** the group has no status and shows no status dot

### Requirement: Rollup is recomputed across tree updates and report surfaces

The same precedence SHALL be applied whenever the report tree is built or recalculated: initial tree construction, live streamed test additions or status changes, test removal, approval recalculation, and restoration after an interrupted run. Per-test statuses SHALL remain unchanged.

Suite status SHALL remain derived in the report UI. It SHALL NOT be added to `report.json`, offline JSON reports, WebSocket messages, or CLI output. Offline replay and the static `crvy-rprtr.html` artifact SHALL derive the same group status from the same test statuses.

#### Scenario: Live update recomputes the group

- **WHEN** a live test update changes a child test from skipped/pending to failed
- **THEN** its group and ancestors become `failed` without a page reload

#### Scenario: Static and offline surfaces agree with live

- **WHEN** the same report data containing a failed test and a skipped/pending test is loaded in the live UI and opened from the static HTML artifact or offline replay
- **THEN** all surfaces show the group as `failed`

#### Scenario: Report and CLI data stay test-scoped

- **WHEN** a run containing a failed test and a skipped test completes
- **THEN** `report.json`, offline JSON reports, and CLI output contain the individual test statuses but no persisted suite-status field
