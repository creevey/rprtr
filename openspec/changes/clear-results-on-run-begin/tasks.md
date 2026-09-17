## 1. Report-state clearing

- [x] 1.1 Write failing tests in `tests/report-state.test.ts`: `applyRunBeginEvent` clears `results`, clears `approved`, sets `status: 'pending'`, keeps identity fields, ignores unknown ids, and leaves tests outside the announced ids untouched; revise the existing re-run tests so `applyTestBeginEvent` is expected to start from no results and no approval — verify: `cd tests && bun test report-state.test.ts`
- [x] 1.2 Implement `applyRunBeginEvent` and the clear-on-begin behavior in `src/report-state.ts` (extract a shared "clear a test's run-scoped state" helper) — verify: `cd tests && bun test report-state.test.ts && bun run typecheck`
- [x] 1.3 Add report-state coverage that a previous `baseline-only` expectation is not carried into a new run's result while `enrichDeclaredBaselines`-style resolution from disk remains possible — verify: `cd tests && bun test report-state.test.ts`

## 2. Protocol and reporter announcement

- [x] 2.1 Write failing schema tests in a new `tests/run-begin-message.test.ts` (mirroring `tests/register-message.test.ts`): `RunBeginDataSchema` accepts `{ testIds: string[] }`, rejects a missing/non-array/wrongly-typed `testIds`, and the incoming WebSocket message schema accepts `type: 'run-begin'` — verify: `cd tests && bun test run-begin-message.test.ts`
- [x] 2.2 Add `RunBeginDataSchema` and the `run-begin` variant to the incoming message schema in `src/schemas.ts` — verify: `cd tests && bun test run-begin-message.test.ts && bun run typecheck`
- [x] 2.3 Write failing reporter tests in a new `tests/reporter-run-begin.test.ts` using the stubbed-`send` pattern from `tests/browser-label.test.ts`: `onBegin` sends `run-begin` with the ids of `suite.allTests()` after `register` and before any `test-begin`; no `run-begin` is sent when `ci: true` — verify: `cd tests && bun test reporter-run-begin.test.ts`
- [x] 2.4 Implement `sendRunBegin` in `src/reporter.ts`, called from `onBegin` after `sendRegister` and guarded by `!this.ci` — verify: `cd tests && bun test reporter-run-begin.test.ts && bun run typecheck`

## 3. Server handling, broadcast, and persistence

- [ ] 3.1 Write failing tests in `tests/server-handlers.test.ts`: `handleRunBegin` clears announced tests, leaves non-announced tests and their approvals intact, broadcasts the cleared state through the existing `sync` message, and schedules a report save; extend the existing re-run test (currently "flips an existing test back to running") to assert the previous result and approval are gone — verify: `cd tests && bun test server-handlers.test.ts`
- [ ] 3.2 Implement `handleRunBegin` in `src/server/handlers.ts` and add the `run-begin` dispatch case in `src/server/app.ts` — verify: `cd tests && bun test server-handlers.test.ts && bun run typecheck`
- [ ] 3.3 Write a failing integration test in a new `tests/run-begin-integration.test.ts` (harness from `tests/vitest-discovery-app.test.ts`): seed a report with results via `createServerApp`, then drive `register` → `run-begin` → `test-begin` over the app's WebSocket message handler and assert `/api/report` and the persisted `report.json` carry cleared announced tests and untouched non-announced tests — verify: `cd tests && bun test run-begin-integration.test.ts`
- [ ] 3.4 Add a backward-compatibility case in the integration test: a reporter that never sends `run-begin` still clears a re-run test on its `test-begin`, and a test outside the announcement keeps its recorded results — verify: `cd tests && bun test run-begin-integration.test.ts`

## 4. Docs, examples, and full gate

- [ ] 4.1 Update `README.md` (and `CHANGELOG.md` if the repo convention requires a manual entry) to state that a new run clears the results and approvals of the tests it executes, while other results persist — verify: `rg -n "clear|approv" README.md`
- [ ] 4.2 Confirm `docs/offline-mode.md` and the static/offline artifact tests still describe untouched behavior (`cd tests && bun test offline.test.ts offline-reports.test.ts offline-artifact.test.ts`) and adjust wording only if it became wrong — verify: `cd tests && bun test offline.test.ts offline-reports.test.ts offline-artifact.test.ts`
- [ ] 4.3 Run the example project against a live server and confirm the sidebar goes clean at run start for a full run and keeps non-filtered results for a single-test run — verify: `bun run example:ct` (or `bun run example`) with the server running
- [ ] 4.4 Full gate: `bun run check` and `bun run test:playwright`, fixing any lint/type/duplication/knip fallout from the new message and handler — verify: `bun run check && bun run test:playwright`
