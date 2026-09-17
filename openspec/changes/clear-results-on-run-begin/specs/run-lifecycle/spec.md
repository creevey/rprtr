## Purpose

Defines how the live rprtr server scopes recorded results and review state to a test run: when a run begins, the tests it will execute start from a clean slate instead of inheriting the previous run's results, diffs and approvals, while tests outside the run keep their state.

## ADDED Requirements

### Requirement: Run-begin announcement

A Playwright reporter connected to a live server SHALL announce the identities of the tests a run is about to execute, before streaming that run's results. The announcement SHALL be sent once per run, before the first test begins. Reporters running in CI/offline mode SHALL NOT send the announcement.

#### Scenario: Announcement precedes streamed results

- **WHEN** a Playwright run starts against a live server
- **THEN** the server receives a run-begin announcement listing the tests the run will execute before the first test of that run begins

#### Scenario: CI run sends no announcement

- **WHEN** the reporter runs in CI or offline mode
- **THEN** no run-begin announcement is produced and no live clearing behavior applies

### Requirement: Run begin clears the announced run's results

On receiving a run-begin announcement, the server SHALL clear the recorded results and status of every announced test that exists in the current report, preserving the test's identity (title, title path, file tokens, browser, project name, location) so the sidebar keeps its shape. Tests not part of the announcement SHALL keep their recorded results. The server SHALL persist the cleared state and SHALL broadcast it to connected browsers.

#### Scenario: Full run clears previously recorded results

- **WHEN** a run announces all tests of a previously recorded run
- **THEN** every announced test remains in the report with its identity intact and no results, and no result from the previous run is rendered for it

#### Scenario: Filtered run preserves tests outside the run

- **WHEN** a run announces a subset of the recorded tests
- **THEN** announced tests are cleared and all other tests keep their recorded results and review state

#### Scenario: Cleared state reaches connected browsers

- **WHEN** a run-begin announcement is processed while browsers are connected
- **THEN** the browsers receive the cleared report state before any result of the new run streams

#### Scenario: Cleared state survives a server restart

- **WHEN** a run-begin announcement is processed and the server restarts before any new result arrives
- **THEN** the reloaded report contains no results for the announced tests

#### Scenario: Announced tests not yet in the report

- **WHEN** an announcement lists tests that have no recorded entry
- **THEN** the report is unchanged for them and they appear only when their results stream

### Requirement: Every test start is a fresh start

A test beginning to run SHALL start from a state with no prior results and no prior approval, whether or not it was covered by a run-begin announcement. Results from a previous run SHALL NOT be carried into a new run's result. This SHALL hold for reporters that do not announce, for providers that expose no upfront test list, and for tests generated after a run starts. Baseline references resolved from disk MAY still be presented for the new result.

#### Scenario: Reporter without announcements

- **WHEN** a reporter that never sends run-begin re-runs a previously recorded test
- **THEN** the test's prior result is not carried into the new run's result

#### Scenario: Provider without an upfront test list

- **WHEN** a run's tests begin without any prior announcement
- **THEN** each test starts without prior results and without prior approval

#### Scenario: Test generated after the run starts

- **WHEN** a test that was not listed in the announcement begins running
- **THEN** it starts without prior results

#### Scenario: Previously failing test passes again

- **WHEN** a test that failed in the previous run passes in a new run
- **THEN** its new result carries no image artifacts recorded for the previous failure

### Requirement: Run-start approval invalidation

Approvals recorded for tests announced by a new run SHALL be cleared when that run begins, so an approval from an earlier run cannot mark the new run's images as already reviewed. Approvals of tests outside the announcement SHALL be preserved. An approval SHALL still be invalidated when a new diff is reported for the approved test.

#### Scenario: Approved test re-runs

- **WHEN** a test was approved in a previous run and a new run announces it
- **THEN** its recorded approval is cleared when the run begins

#### Scenario: Approval outside the run is preserved

- **WHEN** a run announces a subset of tests and a test outside the subset has a recorded approval
- **THEN** that approval is preserved

### Requirement: Artifact review flows are unaffected

Static HTML artifacts and offline JSON reports SHALL continue to replay a single complete run into an empty state, without run-begin or clearing semantics. A server started against downloaded CI artifacts SHALL present those artifacts until a run actually begins against that server. CLI artifact-directory mode SHALL not clear anything on startup.

#### Scenario: Server opened on downloaded artifacts

- **WHEN** the server starts with a report path pointing at downloaded CI artifacts and no run begins
- **THEN** all artifact results and approvals are presented and nothing is cleared

#### Scenario: Static HTML artifact unchanged

- **WHEN** a CI run writes the self-contained HTML artifact
- **THEN** it contains exactly that run's results as before, with no clearing behavior applied

#### Scenario: Offline JSON reports unchanged

- **WHEN** a CI run writes its per-worker offline JSON reports
- **THEN** their event payloads replay into the same report state as before this capability
