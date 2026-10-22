# Tasks

## 1. Precedence contract

- [x] 1.1 Add failing unit tests in `tests/status.test.ts` for the new `rollupStatus` helper: failed + pending/skipped is failed in both operand orders, failed + running is failed, running + pending is running, pending + success is pending, approved + success is approved, success + unknown is success, and two absent statuses stay absent. Verify: `bun run build && cd tests && bun test status.test.ts` (new cases fail against the current allowlist).
- [x] 1.2 Replace `statusUpdatesMap`/`calcStatus` in `src/client/helpers/status.ts` with the explicit rank table from `design.md` D1, export `rollupStatus`, and update the rollup call sites in `path.ts`, `tree-sync.ts`, `suite.ts`, and `helpers.ts`. Verify: `cd tests && bun test status.test.ts` and `bun run typecheck` pass.

## 2. Tree and lifecycle rollups

- [x] 2.1 Add failing tests in `tests/tree-sync.test.ts` proving `treeifyTests` marks a group `failed` when it contains a failed and a skipped/pending test, a nested ancestor inherits the failure, and a live `syncTreeState` update from skipped/pending to failed turns the group and its ancestors red. Verify: `cd tests && bun test tree-sync.test.ts` (the mixed-status cases fail before task 1.2).
- [x] 2.2 Add a failing test in `tests/run-snapshot.test.ts` proving `restoreTestStatuses` followed by `recalcAllSuiteStatuses` rolls a restored failed test plus an untouched skipped/pending sibling up to `failed`. Verify: `cd tests && bun test run-snapshot.test.ts` (the mixed-status case fails before task 1.2).
- [x] 2.3 Confirm every tree recalculation path uses `rollupStatus` and that no suite status is persisted to `report.json`, offline JSON, or WebSocket payloads. Verify: `cd tests && bun test tree-sync.test.ts run-snapshot.test.ts report-state.test.ts` and `bun run typecheck`.

## 3. Documentation and full gate

- [ ] 3.1 Add one sentence to the `README.md` sidebar hierarchy section stating that a group with any failed descendant is shown as failed even when other descendants are skipped or pending. Verify: `bun run format:check`.
- [ ] 3.2 Run the complete gate from the repository root: `bun run check`, plus `bun run test:playwright` because the sidebar status dot rendering changes. Verify: both commands exit 0.
