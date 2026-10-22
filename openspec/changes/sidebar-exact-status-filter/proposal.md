# Proposal

## Why

The sidebar status filter does not match the status it names. `status:failed` currently includes failed, pending, and running tests because `filterTests` treats `pending` and `running` as always relevant to any status filter. Skipped tests are reported as `pending`, so a failure triage list is polluted by tests that did not fail. At the same time, dropping running tests from `status:failed` would make a failed-test rerun vanish from the failed view until it settles, so in-flight tests need to stay visible there.

## What Changes

- Make a status filter match tests whose status equals the requested status exactly, with one exception: `status:failed` also keeps running tests visible so a failed-test rerun stays in view until it settles.
- `status:failed` SHALL show failed tests and running tests, and SHALL NOT show skipped/pending tests that are not part of the run.
- A running test SHALL leave `status:failed` when it passes, and SHALL remain when it fails again.
- `status:pending` SHALL continue to show skipped tests and discovered-but-never-run tests, both of which are represented as `pending` in report data.
- `status:success` and `status:approved` SHALL exclude tests with any other status, including running tests.
- Preserve existing tree-pruning behavior: a suite appears only when it contains at least one matching descendant test.
- Preserve text-only substring filtering and the existing combined text-plus-status behavior.
- Apply the same filtering behavior wherever the client bundle runs: the live server UI, offline replay, and the static `crvy-rprtr.html` artifact.
- Keep filtering view-only: it SHALL NOT mutate test statuses, results, approvals, or persisted report data.

## Capabilities

### New Capabilities

- `report-filtering`: Defines how the report sidebar selects visible tests and suites by status and text across the live UI, offline replay, and the static HTML artifact. Without it, a status filter remains an approximate union that includes skipped tests, so failure triage cannot rely on it. No existing capability covers filtering; `report-tree` defines hierarchy and `report-status-rollup` defines group status, but neither defines which tests a filter exposes.

### Modified Capabilities

None.

## Impact

- Code: `src/client/helpers/suite.ts` (`filterTests`) and its existing callers in `src/client/App.svelte` and `src/client/components/Sidebar.svelte`.
- Tests: a focused client-helper test covering exact status matching, skipped/pending membership, suite pruning, and view-only behavior.
- Docs: `README.md` sidebar section gains a sentence explaining that status filters match exactly.
- No report schema, offline JSON, WebSocket protocol, CLI, package export, dependency, or screenshot-determinism change. The live UI, offline replay, and static artifact share the same client helper, so no separate surface implementation is needed.

## Non-goals

- Changing how runner statuses map into report statuses (`passed` → `success`, `failed` → `failed`, `skipped` → `pending`).
- Adding a distinct `skipped` test status or changing group-status rollup, counts, colours, or next-failed navigation.
- Changing text-only substring matching or the current precedence when a filter combines text and a status token.
- Changing run controls, approval behavior, discovery, or persisted report contents.
