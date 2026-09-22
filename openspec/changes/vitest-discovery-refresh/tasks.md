# Tasks

All bun tests run inside `tests/` (after `bun run build`). Verification commands end every task. Behavior lives in the spec delta `specs/test-runner/spec.md`; implementation choices follow design.md (decisions D1–D9).

## 1. Watcher primitives

- [ ] 1.1 Failing test first: `tests/test-file-watcher.test.ts` — with an injected watch seam assert root computation (config file, deduped directories of listed files, run-context cwd), debounce coalescing of rapid events, artifact-location filtering (`node_modules`, `.git`, `dist`, `coverage`, report/screenshot output, `*-snapshots`, `__screenshots__`), recursive-to-non-recursive fallback with one log, and `dispose()` closing every handle. Implement `src/server/test-file-watcher.ts`. Verify: `cd tests && bun test test-file-watcher.test.ts && cd .. && bun run typecheck`
- [ ] 1.2 Failing test first: extend `tests/test-file-watcher.test.ts` — a successful listing adds only new directories, closes removed ones, and never double-watches a directory already covered by an active recursive root. Implement root-set updates in `src/server/test-file-watcher.ts`. Verify: `cd tests && bun test test-file-watcher.test.ts && cd .. && bun run typecheck`

## 2. Listing results distinguish failure from empty

- [ ] 2.1 Failing test first: extend `tests/vitest-discovery.test.ts` — `runVitestList` returns success-with-entries, success-with-zero for valid empty JSON, and failure for non-zero exit, spawn error, unparseable stdout, and timeout. Implement the result union in `src/server/vitest-discovery.ts` and update startup handling in `src/server/discovered-tests.ts` so failed and empty startup listings keep today's behavior (one log, controls stay enabled, tree untouched). Verify: `cd tests && bun test vitest-discovery.test.ts discovered-tests.test.ts && cd .. && bun run typecheck`
- [ ] 2.2 Failing test first: extend `tests/playwright-discovery.test.ts` the same way for `runPlaywrightList`, keeping startup behavior identical. Verify: `cd tests && bun test playwright-discovery.test.ts discovered-tests.test.ts && cd .. && bun run typecheck`

## 3. Reconcile the discovered layer

- [ ] 3.1 Failing test first: extend `tests/discovered-tests.test.ts` — `reconcileDiscoveredTests` removes placeholders whose identities are missing from the new listing, adds newly listed tests as `pending`, preserves recorded results and approvals without duplicates, and clears the whole discovered layer for a successful empty listing. Implement in `src/server/discovered-tests.ts`. Verify: `cd tests && bun test discovered-tests.test.ts && cd .. && bun run typecheck`

## 4. Serialized refresh session

- [ ] 4.1 Failing test first: extend `tests/discovered-tests.test.ts` — one listing runs at a time; changes during an in-flight listing produce exactly one follow-up; changes while `isRunning` are queued and flushed by `notifyRunSettled()`; a failed listing leaves the tree untouched and logs once; watch roots update after each successful listing; `dispose()` cancels queued work. Implement the session in `src/server/discovered-tests.ts`. Verify: `cd tests && bun test discovered-tests.test.ts && cd .. && bun run typecheck`

## 5. Server wiring: startup, settlement, disposal

- [ ] 5.1 Failing test first: extend `tests/vitest-discovery-app.test.ts` — a seeded app refreshes the pending tree after a watched test file is edited (new test appears; deleted test's placeholder disappears) without a run or restart; an artifact-only write (snapshot directory) schedules no re-enumeration; `close()` disposes watchers so later edits change nothing. Implement session start and disposal in `src/server/app.ts`. Verify: `cd tests && bun test vitest-discovery-app.test.ts && cd .. && bun run typecheck`
- [ ] 5.2 Failing test first: extend `tests/vitest-discovery-app.test.ts` and `tests/run-controller.test.ts` — a file change during a streamed run does not mutate the tree and `run-end` reconciles it; a UI-launched child exit settles the same way. Implement the run-settlement callback in `src/server/routes.ts` (RoutesContext), `src/server/run-controller.ts` (`handleChildExit`), `src/server/handlers.ts` (`handleRunEnd`), and `src/server/server-factories.ts`. Verify: `cd tests && bun test vitest-discovery-app.test.ts run-controller.test.ts && cd .. && bun run typecheck`

## 6. Playwright parity

- [ ] 6.1 Failing test first: extend `tests/playwright-discovery-app.test.ts` — the edit/delete refresh flow works in a seeded Playwright project, and a refresh keeps recorded results and approvals unchanged. Verify: `cd tests && bun test playwright-discovery-app.test.ts && cd .. && bun run typecheck`

## 7. Docs and full gate

- [ ] 7.1 Update README.md (pre-run discovery section and the `--config` table row: the pending list now refreshes on test-file and config changes; note that helper edits outside watched test directories still need a run or restart) and `examples/vitest-browser/README.md` (drop the "edits made after the server started appear on the next run" FAQ line). Verify: `bun run format:check` and manual review against implemented behavior
- [ ] 7.2 Full gate + browser regression: `bun run check && bun run test:playwright`
