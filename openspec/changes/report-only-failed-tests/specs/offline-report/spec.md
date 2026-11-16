# Spec Delta

## ADDED Requirements

### Requirement: Failed-only offline artifacts

When `reportOnlyFailedTests` is `true` and the run is in CI/offline mode, the Playwright and Vitest reporters SHALL omit from the offline report and the static HTML artifact every test attempt that ended `passed` or `skipped`, including its `test-begin` event, and SHALL NOT copy its screenshots or baselines into `screenshotDir`. Attempts that ended in any other status SHALL be reported unchanged. Live server runs SHALL ignore the option.

#### Scenario: Passing tests are left out

- **WHEN** a CI run with `reportOnlyFailedTests: true` has one passed, one skipped and one failed test
- **THEN** the offline report contains only the failed test's `test-begin` and `test-end` events, followed by `run-end`

#### Scenario: Retried test keeps its failed attempt

- **WHEN** a test fails and then passes on retry in such a run
- **THEN** the report keeps the failed attempt's events and omits the passing attempt

#### Scenario: Live runs are unaffected

- **WHEN** the reporter streams to a live server with `reportOnlyFailedTests: true`
- **THEN** passing tests are reported as without the option
