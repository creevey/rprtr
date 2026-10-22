# Design

## Context

See `proposal.md` — Why. Filtering is a client-side projection implemented by `filterTests` in `src/client/helpers/suite.ts`. The sidebar and keyboard navigation both consume it (`src/client/components/Sidebar.svelte`, `src/client/App.svelte`). The live UI, offline replay, and static `crvy-rprtr.html` artifact bundle the same client code, so one predicate covers every surface.

Report data does not carry a distinct skipped status. `mapStatus` maps a skipped runner result to `pending`, the same status used for discovered-but-never-run tests. `running` is a separate status. Today the status branch of `filterTests` includes `pending`, `running`, and the requested status for every non-null status filter, which is why skipped tests leak into `status:failed`. Dropping running tests from `failed` fixes the leak but makes a failed-test rerun disappear from the failed view as soon as it starts, so `failed` keeps running tests as a deliberate exception.

## Goals / Non-Goals

**Goals:**

- Make status filters exact predicates over a test's report status, except that `status:failed` keeps running tests visible.
- Keep a failed-test rerun visible under `status:failed` until it passes or fails again.
- Keep skipped tests visible under `status:pending` without inventing a new status.
- Preserve suite pruning, title matching, view-only behavior, and the shared client bundle.
- Pin the intended behavior with a focused helper test.

**Non-Goals:**

- Changing the runner-to-report status mapping or adding a `skipped` status.
- Keeping running tests visible under `status:pending`, `status:success`, or `status:approved`.
- Changing group-status rollup, status counts, colours, icons, next-failed navigation, or run controls.
- Changing text-only substring matching or the combined text-plus-status precedence.
- Persisting filter state or filtering on the server.

## Decisions

### D1: Compare the report status for equality, with running retained for failed

Replace the `['pending', 'running', status].includes(test.status)` union with exact equality, plus one exception: when the requested status is `failed`, a `running` test stays visible. A status filter answers “which tests have this status now”, except that failure triage is also a rerun workflow: a failed test is reset to `running` while it is retried, and removing it from the failed view would hide the very tests the reviewer is rerunning. When the rerun settles, the live tree re-evaluates the filter: a pass removes the test, and another failure keeps it. Every other filter stays exact, so a running test cannot leak into `pending`, `success`, or `approved`.

Alternatives considered:

- **Strict equality with no exception.** Rejected: the reported failure-triage workflow loses its subjects precisely while the rerun is in flight.
- **Include running under every status filter** (the old union minus `pending`). Rejected: a test running for unrelated reasons would appear under `success` or `approved`, which is just as misleading as the original skipped leak.
- **Exclude only completed pending tests** (`results !== undefined`) while keeping running in every filter. Rejected: discovered-but-never-run tests are still pending and would still pollute failure triage, and the rule would infer completion from an unrelated field instead of the status being filtered.
- **Include pending tests in `failed` during a run.** Rejected: queued reruns and discovered-but-never-run tests are both `pending`, so this would reintroduce the pollution this change exists to remove.
- **Inspect the `skip` field to distinguish skipped from pending.** Rejected: streamed results do not populate `skip`; status is the canonical report signal, and adding a second source of truth would drift.

### D2: Pending stays the skipped bucket

Skipped tests and discovered-but-never-run tests both remain visible under `status:pending`. This is consistent with the existing status mapping and avoids a report-schema or protocol change. The distinction between “skipped” and “not run yet” is not required by this change.

### D3: Reuse the existing helper and pruning

`filterTests` already owns recursive suite cloning, title matching, and empty-branch pruning. Only its test-visibility predicate changes; no new module or dependency is needed. Suites continue to be omitted when no descendant matches, and ancestors are retained automatically by the recursive build.

### D4: Keep filtering view-only and client-side

Filters remain transient UI state. No status, result, approval, or report field is rewritten, and no filter state is sent to the server or written to artifacts. The report-wide counts and next-failed navigation continue to read the unfiltered tree.

### D5: Preserve text and combined-filter behavior

Text-only substring matching is unchanged: it matches suite or test titles case-insensitively, and a matching suite exposes its descendants. When a filter contains both a status token and text, the existing status-only precedence is preserved; making the two criteria combine with AND is a separate UX decision and would widen this change.

Alternatives considered: make `text status:failed` require both matches now. Rejected for scope control; it changes behavior beyond the reported skipped-test leak and needs its own scenarios.

## Risks / Trade-offs

- **A running test under `status:failed` may ultimately pass** → It remains visible only while it is in flight, then leaves the filter. This is the trade-off that keeps failed reruns reviewable. Document the exception in the sidebar docs.
- **Users may expect pending/skipped to remain in failed triage** → The previous behavior was the reported defect; `status:pending` remains the explicit place to find skipped tests.
- **Combined text-plus-status remains status-only** → Existing behavior is preserved and called out as a non-goal; a later change can make criteria additive.
- **A future surface bypasses the client helper** → The live, offline, and static surfaces share the same client bundle; the focused helper test anchors the contract if a second implementation appears.

## Migration Plan

No migration. Filters are transient and recomputed from loaded report data on every render; stored reports and artifacts are unchanged. Rollback is a normal revert of the client predicate and its test.

## Package Surface

No change to the `exports` map, `bin`, peer dependencies, or `dist/` layout. `src/client/helpers/suite.ts` is bundled client code, not a public export.
