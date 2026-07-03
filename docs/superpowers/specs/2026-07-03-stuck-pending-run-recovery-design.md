# Stuck-Pending Run Recovery Design

**Date:** 2026-07-03
**Topic:** Eliminate the orphaned-pending failure mode in the run-from-UI feature: when a UI-triggered run produces no test events, the optimistically-marked-pending tests must revert to their previous status and the user must be told why, instead of being left staring at a tree full of pending dots with no explanation.

## Overview

The run-from-UI feature marks tests `pending` optimistically before a run is confirmed (`src/client/App.svelte` `handleStart`/`handleRunItem` → `markTestsPending`). A test's pending status is only ever cleared by an arriving `test-begin`/`test-update` event for that test. When a run produces **zero** events, nothing clears the pending state and the tree is orphaned:

- A `--test-list` entry that matches nothing (format drift across Playwright versions) — Playwright runs zero tests and exits; no events flow.
- The spawned reporter never connects (Playwright boot crash, broken config import, `@crvy/rprtr` unresolvable) — the child exits, but no events flow.
- A filtered run whose child dies before reporting.

In every case the browser shows a tree full of pending dots and a ▶ that is clickable again, with no indication that the run failed. All diagnostics went to the server terminal (`stdio: 'inherit'`), which the user may not be watching. This is silent **and** stuck — the worst combination.

A pre-existing variant of the same bug: a second browser tab that clicks Start during an in-flight run passes the local `isRunning` guard (which is only flipped by the async `run-status` WebSocket message), marks **its** tree pending, receives a `409 already-running`, and is left orphaned.

## Background: verified facts

- **`markTestsPending` is a local, non-broadcast mutation.** `src/client/helpers/suite.ts:185-191` mutates `node.status = 'pending'` on the client tree directly. Other tabs never see it; they only observe the test events that follow. Therefore **only the initiating client knows which tests it marked pending** — the server cannot tell it what to restore.
- **`isRunning` on the client is WebSocket-driven.** `src/client/App.svelte` sets `isRunning` only from `run-status` messages. There is a gap between a successful `POST /api/run` (200) and the arrival of `run-status: { running: true }` during which `isRunning` is still `false` locally. A second click in that window, or a second tab, bypasses the existing `if (isRunning)` guard.
- **The server already broadcasts `run-status: { running: false }` on every child exit** (`src/server/run-controller.ts:255-268`), including the reporter-never-connected case. This is the safety net that resets `isRunning`; it can also drive the client's recovery.
- **`recalcAllSuiteStatuses`** (`src/client/helpers/suite.ts:174-183`) recomputes suite rollup dots from child statuses. Restoring individual test statuses and re-running this yields correct suite dots.
- **The client has no unit-test harness for Svelte components**, but `src/client/helpers/` is pure functions already covered by `bun:test` directly. New pure helpers inherit that coverage path.
- **`TestStatus`** is the existing status union (`success | failed | pending | approved | …`) used throughout the client.

## Goals

1. When a UI-initiated run produces no test events, revert every test the client optimistically marked pending back to its pre-run status, and surface an inline message explaining the run produced no results.
2. Restore tests that were orphaned in a **partial** failure (some tests ran, some did not) without a noisy message.
3. Close the double-click / cross-tab orphan race that the local `isRunning` guard misses.
4. Require **no server changes, no schema changes, and no new WebSocket message type.** The client created the optimistic lie; the client owns the undo.
5. Keep the deterministic logic in a pure, `bun:test`-coverable helper; leave only wiring in the Svelte component.

## Non-Goals

1. Surfacing server-terminal (Playwright stdout/stderr) diagnostics in the browser. Output continues to go to the server terminal; the inline message only points the user there. Piping child output is an explicit prior non-goal.
2. Introducing a new "didn't run" status type. Recovery restores prior statuses; no new visual state is added.
3. Handling a child that neither exits nor produces events (a true hang). The Stop button (SIGTERM → 5s grace → SIGKILL) remains the user's recovery; on the resulting child exit, `run-status:false` fires and this design's recovery runs.
4. A watchdog / connection-timeout for the spawned reporter. The child-exit safety net already covers "reporter never connected."
5. Counting or messaging partial failures beyond the silent revert. The loud case is total failure (zero events).

## Design Decisions

### D1 (accepted): client-owned snapshot and revert

Only the initiating client knows which tests it marked pending (the mutation is local and non-broadcast), so the snapshot and revert both belong client-side. A server-authoritative "empty run" signal was considered and rejected: the client would still have to snapshot and revert, so the server flag would only replace the client's event-tracking heuristic without removing any client complexity. Client-side event tracking is robust because the bookkeeping lives in component state that survives WebSocket reconnects, and `run-status:false` is broadcast to all tabs and arrives on reconnect.

### D2 (accepted): per-test revert keyed on received event ids

The snapshot is `Map<testId, TestStatus>`. During the run the client records the set of test ids that produced a `test-begin`/`test-update`. On run end, any snapshotted id **not** in that set is restored to its prior status. This catches both total failure (zero events → restore everything) and partial failure (restore only the orphans) with one mechanism. "Zero events overall" is the trigger for the inline message; partial failures revert silently.

### D3 (accepted): race closed via `runSnapshot !== null`, not optimistic `isRunning`

The double-click/cross-tab race exists because `isRunning` is flipped asynchronously by the WebSocket. Setting `isRunning = true` optimistically on a 200 response would close it but risks a stuck-true state if the WebSocket is flaky. Instead the run-initiation guard becomes `if (isRunning || runSnapshot !== null)`: the snapshot is captured synchronously before the POST, so a second click in the same tab sees it non-null and bails. The 409/400 response path performs the full restore for the cross-tab case. `isRunning` remains purely WebSocket-authoritative.

### D4 (accepted): message only on total failure; persists until the next run starts

`runMessage` is set to "Run produced no results — see the server terminal for details." only when zero events arrived during the run. It is **not** cleared by the `run-status:false` that set it; it persists so the user can read why their tree reverted, and is cleared by the next `run-status:true` (the next run's start). Partial failures revert silently to avoid nagging.

## Architecture and Data Flow

### Component state (plain `let` — not reactive; nothing renders off these directly)

- `runSnapshot: Map<string, TestStatus> | null`
- `runEventIds: Set<string>`

Both are scoped to a single run attempt and cleared on every terminal path.

### Run lifecycle

```
initiate ──▶ capture snapshot ──▶ mark pending ──▶ POST /api/run
                                                              │
                                              ┌───────────────┼───────────────┐
                                              ▼               ▼               ▼
                                          200             409/400        (WS run-status:true)
                                              │               │               │
                                  snapshot stays active   full restore    isRunning=true
                                              │          clear snapshot    runMessage=null
                                              │               │
                                              │          (done)
                                              ▼
                            (WS test-begin/test-update) ──▶ record id in runEventIds
                                              │
                            (WS run-status:false) ──▶ finalizeRunSnapshot()
                                                          │
                                restore ids in snapshot not in runEventIds
                                recalcAllSuiteStatuses
                                if runEventIds.size === 0 → runMessage = "…no results…"
                                clear snapshot + runEventIds
```

### `finalizeRunSnapshot()`

1. If `runSnapshot === null`, return (the run was not initiated by this client — e.g. a CLI run in another terminal — so there is nothing to revert).
2. For each test under the root whose id is in `runSnapshot` and **not** in `runEventIds`, restore `test.status` to the snapshotted value.
3. Call `recalcAllSuiteStatuses(tests)` so suite dots reflect the restored statuses.
4. If `runEventIds.size === 0`, set `runMessage = 'Run produced no results — see the server terminal for details.'`.
5. Set `runSnapshot = null` and `runEventIds = new Set()`.

### Unified entry point

`handleStart(filters?: RunFilters, target?: CrvyRprtrSuite | CrvyRprtrTest)` replaces the current split. The Start button calls `handleStart()` (target defaults to the `tests` root → run-all). `handleRunItem(item)` builds descriptors, returns early with a message if none have a location, otherwise calls `handleStart({ tests: descriptors }, item)`. Snapshot capture and mark-pending become a single code path keyed on `target ?? tests`.

## Pure Helper — `src/client/helpers/run-snapshot.ts`

```ts
import type { CrvyRprtrSuite, CrvyRprtrTest, TestStatus } from '../../types'

/** Captures testId → current status for every test under `node` (scoped to a subtree or the root). */
export function captureTestStatuses(node: CrvyRprtrSuite | CrvyRprtrTest): Map<string, TestStatus>

/**
 * Restores `test.status` for every test under `root` whose id is in `snapshot`
 * and NOT in `receivedIds`. Leaves tests that did receive events untouched.
 * Returns the number of tests restored.
 */
export function restoreTestStatuses(
  root: CrvyRprtrSuite,
  snapshot: Map<string, TestStatus>,
  receivedIds: Set<string>,
): number
```

Both walk the tree using the existing `isTest` / `getChildrenArray` traversal pattern (consistent with `src/client/helpers/suite.ts`). `captureTestStatuses` is scoped to the marked node (subtree for filtered runs, root for run-all). `restoreTestStatuses` walks the root to locate snapshotted ids and is a pure function over the tree — no Svelte, no globals — so it is directly unit-testable.

## App.svelte Wiring

- Import `captureTestStatuses`, `restoreTestStatuses`.
- Add `runSnapshot` and `runEventIds` component variables.
- `handleStart(filters?, target?)`:
  1. Guard: `if (isRunning || runSnapshot !== null) { runMessage = 'A run is already in progress'; return }`.
  2. `const markTarget = target ?? tests`.
  3. `runSnapshot = captureTestStatuses(markTarget); runEventIds = new Set()`.
  4. `markTestsPending(markTarget); recalcAllSuiteStatuses(tests)`.
  5. `POST /api/run` with `JSON.stringify(filters ?? {})`.
  6. On `200`: no action (the WebSocket drives `isRunning`).
  7. On `409`/`400`: `restoreTestStatuses(tests, runSnapshot, runEventIds)` (full restore — no events could have arrived for our run), `recalcAllSuiteStatuses(tests)`, set `runMessage` from the reason (`already-running` → "A run is already in progress"; `no-tests` → "No tests selected"; else → "Connect a Playwright reporter to enable running"), then `runSnapshot = null`.
- `handleRunItem(item)`: build descriptors; if empty, set `runMessage` and return; otherwise `handleStart({ tests: descriptors }, item)`. The top-of-`handleStart` guard now also protects the filtered path.
- WebSocket `run-status` case: split on `msg.data.running`. `true` → `isRunning = true; runMessage = null`. `false` → `isRunning = false; finalizeRunSnapshot()`.
- WebSocket `test-begin`/`test-update` cases: after the existing `syncTreeState`, `if (runSnapshot !== null) runEventIds.add(msg.data.id)`.

## Edge Cases

| Scenario                                                                                | Behavior                                                                                                            |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Total failure (0 events: bad `--test-list` match, reporter never connects, child crash) | Restore all snapshot; show "Run produced no results — see the server terminal for details."                         |
| Partial failure (some tests orphaned, some ran)                                         | Restore only orphans; no message                                                                                    |
| 409 already-running (cross-tab double-click)                                            | Full restore + "A run is already in progress"                                                                       |
| 400 no-tests                                                                            | Full restore + "No tests selected"                                                                                  |
| Stop mid-run                                                                            | `run-status:false` → finalize; started-but-unfilled tests keep their last status (existing behavior, no regression) |
| Successful run                                                                          | `runEventIds` populated → restore nothing, no message, snapshot cleared                                             |
| First run from empty state                                                              | Empty snapshot; events populate the tree normally; on failure, empty restore + message                              |
| `run-status:false` from a run this client did not initiate (CLI in another terminal)    | `runSnapshot` is null → `finalizeRunSnapshot` no-ops; no spurious revert                                            |

## Testing Strategy

### `tests/run-snapshot.test.ts` (new, `bun:test`)

Pure-function unit tests with synthetic `CrvyRprtrSuite` trees:

- `captureTestStatuses`: builds the correct `id → status` map; scoped to a subtree (does not capture siblings); captures nested tests.
- `restoreTestStatuses`: restores only ids not in `receivedIds`; leaves received ids untouched; returns the correct count; walks nested suites; restoring a status then `recalcAllSuiteStatuses` yields the correct parent rollup.

### App.svelte wiring

No Svelte unit-test harness exists in the project (accepted project-wide). The wiring is covered by the existing Playwright UI snapshot tests plus manual verification — the same strategy used by the prior run-from-UI specs. The deterministic recovery logic lives in the pure helper and carries the regression coverage; the component only records ids and calls the helper.

### Out of scope

An end-to-end test that drives a real no-event run through the browser (requires mocking `/api/run` and the WebSocket against a live server). The pure helper validates every observable behavior of the recovery; the wiring is mechanical.

## Open Questions

None. The one residual decision — message on partial failure — is resolved by D4 (silent revert).
