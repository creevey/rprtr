## Context

See `proposal.md` — Why. Today the live server loads `report.json` at startup (`src/server/app.ts:266`) and keeps results across runs; `applyTestBeginEvent` deliberately preserves the previous result while a test re-runs (`src/report-state.ts:186-219`); `run-end` culls tests not seen in the run unless the run was UI-launched with a filter (`src/server/handlers.ts:89-104`, `src/server/server-factories.ts:65-84`). Reporters connect once per run: Playwright from `onBegin` (`src/reporter.ts:84-90`), Vitest per browser project (`src/vitest.ts:115-118`). There is no run identity in the protocol and no reconnect after a dropped reporter connection.

## Goals / Non-Goals

**Goals:**

- A running server presents a run's own results as the only results for the tests that run participates in.
- Work for externally started Playwright runs, UI-launched runs, Vitest runs, older reporters, and tests generated after a run starts.
- Keep results of tests outside the run intact, including their approvals.
- Do not disturb startup loading, CI artifact review, static HTML output, or offline JSON reports.

**Non-Goals:**

- Run-end cull changes (see proposal Non-goals for the reliability argument).
- Run identity, reconnect, or multi-shard coordination.
- Seed the sidebar with announced-but-not-yet-started tests; `test-begin` remains the only creator of test entries.
- Changing screenshot resolution, baseline paths, or approval copying.

## Decisions

### Two-layer clearing: announcement plus per-test reset

`run-begin` clears the whole announced set immediately; `applyTestBeginEvent` also resets a test as it begins, unconditionally. The announcement gives the user-visible "clean slate at run start" and full-set clearing before results stream; the per-test reset covers reporters that cannot announce (Vitest, older reporters) and tests born after the run started, and makes backward compatibility structural rather than best-effort.

Alternatives rejected: per-test clearing only (stale results stay visible for the minutes a long suite takes to reach each test); clearing on `register` (Vitest registers once per browser project, so a second project would wipe the first project's results; concurrent matrix shards would wipe each other); clearing on server start (breaks resume and the `crvy-rprtr --report-path ./artifacts` review flow); clearing inside `POST /api/run` (would clear even when `prepareRun` subsequently fails, and would not cover external runs).

### Announcement carries test ids only

The message is `{ type: 'run-begin', data: { testIds: string[] } }`, added to the incoming WebSocket schema and dispatched like the other reporter messages. Ids are stable across runs (already relied upon by re-run replacement), and clearing only needs to match existing entries. Full descriptors were considered so the server could pre-create pending entries, but that duplicates identity logic and implies an entry-creation path that specs deliberately keep on `test-begin`.

Added to `src/schemas.ts` (new message variant), sent from `src/reporter.ts` guarded by `!this.ci`, handled in `src/server/app.ts` + `src/server/handlers.ts`. No new module: `src/report-state.ts` gains a pure `applyRunBeginEvent` alongside `applyTestBeginEvent`, which is where all event-to-state transitions already live.

### Clear semantics: strip results and approval, keep identity, mark pending

For every matching test: delete `results`, delete `approved`, set `status: 'pending'`, keep title/titlePath/fileTokens/browser/projectName/location. Deleting the entry would make the sidebar flicker (tests disappearing until `test-begin` re-creates them); keeping `baseline-only` images was rejected as a product decision — the request is a clean slate, and the server re-resolves baseline expectations from disk for passing tests anyway.

### Broadcast through the existing `sync` message

The cleared state is pushed with the existing full-state `sync` broadcast (`src/server/handlers.ts:148-159`), which the client already applies by replacing the tree. A dedicated `tests-cleared` client event was rejected: it adds client code for no behavioral difference while announcement-based clearing is the only producer.

### Persist the cleared state with the existing debounced saver

`scheduleReportSave()` after clearing, so a restart mid-run does not resurrect results that the run has already superseded. The 250 ms debounce can lose a clear only if the server dies within that window before any result arrives — an acceptable local-tool trade-off versus an immediate synchronous write on every run start.

### `isRunning` stays driven by test-begin and run-end

The announcement does not set `isRunning`. A run that dies before its first test would otherwise leave a stuck running state; UI-launched runs already broadcast `run-status` from `RunController`.

### `run-end` culling, Vitest, and CI are untouched

See proposal Non-goals for culling. Vitest needs no reporter change (no upfront list exists; per-test clearing applies). CI/offline/static artifacts are untouched because the announcement is not sent and replay builds from empty state.

## Risks / Trade-offs

- [Passing tests lose previously preserved baseline previews] → `preservePreviousPassingImages` had the previous result as its only input; server-side `enrichDeclaredBaselines` re-resolves declared visuals from disk on `test-end`, so the live UI recovers previews. Cover both paths with report-state tests and an example run.
- [Approval badges for re-run tests disappear at run start] → Intended (proposal marks it breaking for live review state); note it in README/CHANGELOG so consumers are not surprised.
- [Overlapping concurrent runs (matrix shards) clear each other's results for shared tests] → Announced sets are normally disjoint; overlap resolves to last-cleared state and re-streams. Local-tool acceptable.
- [Very large suites make `sync` broadcasts heavy] → Same payload class as `/api/report`; the client already replaces full trees on every message. Revisit only if measurements show pain.
- [New reporter against an older server logs an invalid-message error per run] → Reporter and server ship from the same package version; per-test clearing still cleans results if the announcement is ignored.

## Migration Plan

Additive protocol change: no `report.json` schema migration (`pending` tests without results already validate), no data cleanup, no config change. Published surface is unchanged: no new exports or export-map entries, `crvy-rprtr` bin unchanged, peer dependencies unchanged, `dist/` layout unchanged, and no new dependency (the existing `ws`/Zod stack covers the message). Rollback is reverting the package version; previously written reports remain readable. Verification gates: focused `bun test` suites for report-state and server handlers, `bun run test:playwright`, and the full `bun run check`.

## Open Questions

None — run identity, culling scope, and UI clear controls are explicitly parked in the proposal's Non-goals.
