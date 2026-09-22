# Proposal: vitest-discovery-refresh

## Why

Pre-run discovery is one-shot: the pending tree reflects server start (archived `vitest-discovery` and `playwright-pre-run-listing` both list file watching as a non-goal). Add, rename, or delete a test while the server runs and the sidebar shows a tree that no longer matches the project until a full run replaces it — exactly the workflow the pre-run tree exists for (choose what to run before running it).

## What Changes

- While a server session has a seeded run context (Vitest or Playwright), the server watches the runner config and the directories of listed test files. Changes are debounced and re-enumerated through the same collection-only listing (`vitest list --json` / `playwright test --list`) — no test execution, no browser launch.
- Re-discovery reconciles instead of appending: recorded run results and approvals are never downgraded, the discovered layer is replaced by the new listing (new tests appear `pending`; placeholders for deleted or renamed tests disappear), and connected browsers get the existing `sync` broadcast. No client change.
- Changes observed during a run are not applied mid-run; they are reconciled once the run settles, so streamed results and approvals are never mutated while running. Re-listings serialize — rapid edits coalesce into one spawn.
- A failed or unavailable watcher/listing degrades gracefully: the current tree stays, run controls stay enabled, one log line, and startup-only discovery still works. Watchers are disposed with the server.
- No new CLI flags, no new dependencies (Node's built-in `fs.watch`), no wire-format or public-export changes; persisted reports keep filtering `discovered:` entries.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `test-runner`: adds a live re-discovery requirement on top of "Pre-run test tree discovery" — watched roots, debounce, reconcile-keeping-results, run-settle deferral, serialized re-listing, graceful degradation, and disposal. Without it the capability's "tree before any run" promise is only accurate at server start; after any project edit the sidebar misrepresents what a run would execute. The existing startup discovery behavior, the shared `src/server/discovered-tests.ts` machinery, and the per-runner listing modules are extended, not replaced.

## Impact

- **Server**: new `src/server/test-file-watcher.ts` (`fs.watch` roots, debounce, disposal); `src/server/discovered-tests.ts` gains reconcile plus a serialized refresh pipeline; `src/server/app.ts` startup wiring and close disposal. `withoutDiscoveredTests` persistence filtering is unchanged.
- **Unchanged surfaces**: reporter, Svelte client, wire schema, CLI flags, public exports (`.`, `./server`, `./rendering`, `./types`), peer dependencies, dist layout. No `docs/*.md` page behavior changes.
- **Docs**: README.md discovery/run-buttons section and the example project READMEs that describe the startup-only list.
- **Tests**: new `tests/test-file-watcher.test.ts` plus app-level refresh tests mirroring `tests/vitest-discovery-app.test.ts` and `tests/playwright-discovery-app.test.ts`.

## Non-goals

- **Manual refresh control** — no refresh button, REST endpoint, or CLI flag; watching is the only trigger.
- **Watching beyond test sources** — edits to helpers outside watched test directories refresh only when a watched file or the config changes; no module-graph or whole-repo watching.
- **Re-discovery in static/offline artifact mode or CI runs** — there is no live server session to keep current.
- **Changing reporter/register semantics or per-test rerun behavior** — discovery remains server-side and collection-only.
