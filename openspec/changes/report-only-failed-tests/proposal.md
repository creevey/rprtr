# Proposal

## Why

Large visual suites produce CI artifacts dominated by passing tests: every passed Playwright screenshot copies its baseline into `screenshotDir`, and every passed test lands in the offline report and the static `crvy-rprtr.html`. Teams migrating from Creevey relied on its `reportOnlyFailedTests` option to keep CI artifacts limited to what needs review.

## What Changes

- Both reporters accept `reportOnlyFailedTests?: boolean` (default `false`).
- In CI/offline mode, a test whose final attempt ended `passed` or `skipped` is left out of the offline report and the static HTML artifact, together with its `test-begin` event; its screenshots and baselines are not copied.
- Failed attempts of a test that later passed on retry stay in the artifacts.
- Live server runs ignore the option, so the UI still lists and approves passing tests.

## Non-goals

- Filtering the live UI; the existing `status:failed` filter covers that.
- Changing the offline report schema or replay semantics.

## Impact

- Code: `src/transport.ts`, `src/reporter.ts`, `src/vitest.ts`, `src/reporter-helpers.ts`.
- Tests: `tests/report-only-failed-tests.test.ts`, `tests/vitest-reporter.test.ts`.
- Docs: `README.md` option tables.
