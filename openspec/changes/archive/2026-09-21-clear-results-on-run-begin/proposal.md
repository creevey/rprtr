## Why

The live UI server stays up for a whole development session, so the sidebar keeps showing the previous run's statuses, diffs and approvals. When a new run starts, old results linger: for externally started runs they stay until each test's new result arrives, results of tests outside the current filter are indistinguishable from fresh ones, and previously approved diffs keep their review badges into a run that is about to replace them. A run's results should belong to that run.

## What Changes

- New reporter→server WebSocket message `run-begin`, sent by the Playwright reporter at `onBegin` with the list of tests the run will execute.
- On `run-begin` the server clears previous results and approvals for exactly those tests, broadcasts the cleared state (reusing the existing `sync` event), and persists it. Tests outside the run set keep their results — the current filtered-run preservation stays intentional.
- `applyTestBeginEvent` stops preserving a prior result while a test re-runs: every `test-begin` starts that test with no results and no approval. This covers older reporters, Vitest, and dynamically generated tests for which no upfront test list exists.
- **BREAKING** for live UI review state only: approvals of tests participating in a new run are invalidated when the run begins, not only when a new diff arrives from that run's result.

## Capabilities

### New Capabilities

- `run-lifecycle`: live server behavior across run boundaries — run-begin announcement, clearing run-scoped results and approvals, and per-test fresh start. Without it, stale results keep mixing across runs and previously approved diffs keep their review badges into a run that is about to replace them. The behavior currently lives in `src/server/handlers.ts` and `src/report-state.ts`; no spec under `openspec/specs/` covered it. It extends the approval-invalidation rule of the in-flight `screenshot-approval` capability (introduced by `vitest-approval`, not yet archived) from "new diff invalidates" to "new run starts fresh".

### Modified Capabilities

None — `openspec/specs/` is empty, so no existing capability spec can be modified.

## Non-goals

- Clearing on server startup or ignoring `report.json` / offline reports — the CI artifact review flow (`crvy-rprtr --report-path ./artifacts`, `docs/offline-mode.md`) keeps working unchanged.
- Static `crvy-rprtr.html` and offline JSON reports: they replay one complete run into empty state; no clearing behavior is added or needed there.
- A UI "Clear results" button or an HTTP clear endpoint.
- Run identifiers, reconnect handling, or concurrent/multi-shard reporter coordination.
- Vitest `run-begin` with an upfront test list (Vitest exposes none before the run); Vitest relies on per-test clearing.
- Changing run-end culling. Distinguishing an externally filtered run from deleted tests is unreliable (Playwright reports no filter metadata for positional/grep selections), and losing the cull would leave deleted tests in the sidebar forever. External filtered runs keep today's run-end behavior; UI-launched filtered runs already preserve non-participating results.

## Impact

- Protocol: new incoming message variant in `src/schemas.ts`, dispatch in `src/server/app.ts`, send from `src/reporter.ts`.
- State: clearing at run-begin and per test-begin in `src/server/handlers.ts` and `src/report-state.ts`; persistence via `scheduleReportSave()`; `broadcastSync()` for the cleared state.
- Client: no new WebSocket event required if `sync` is reused; `src/client/App.svelte` optimistic pending markers stay as-is.
- Published surface unchanged: no new exports, bin unchanged, protocol addition is backward compatible (older reporters rely on per-test clearing).
- Docs: `docs/offline-mode.md` and CI flows remain accurate; README wording about stale live results may need a sentence.
