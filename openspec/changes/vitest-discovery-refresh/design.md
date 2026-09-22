# Design

## Context

See `proposal.md` — Why. Current state that shapes the approach:

- Pre-run discovery is one-shot: `seedDiscoveredTests` (`src/server/discovered-tests.ts`) is fired once from `startDiscovery` (`src/server/app.ts`) after the report is loaded; it lists through `runVitestList` / `runPlaywrightList`, synthesizes `discovered:`-prefixed `pending` entries, and merges them under loaded results. `withoutDiscoveredTests` keeps placeholders out of persistence.
- No filesystem watcher exists anywhere in `src/`; the artifact paths (report.json, offline JSON, static HTML) are event-derived by design.
- A run's recorded results are scoped by `run-lifecycle` semantics: `applyRunBeginEvent` clears announced tests, `applyTestBeginEvent`/`applyTestEndEvent` stream results, `finalizeRunEvent` culls tests outside a full run. Refresh must not disturb any of that.
- `reportData.isRunning` settles through two paths: reporter `run-end` (`handleRunEnd` → `finalizeRunEvent`) and a UI-launched child exiting (`RunController.handleChildExit`). Both already broadcast on the WebSocket.
- The listers currently collapse every failure — spawn error, timeout, non-JSON output — into `[]`, so callers cannot tell "the project has no tests" from "the listing failed".
- Verified probe (Bun 1.4.2 / Node 25, macOS): `fs.watch(root, { recursive: true })` reports nested file creation and modification. Node 22+ supports recursive watch on Linux; Bun's Linux behavior is not confirmed, so the design needs a non-recursive fallback.

## Goals / Non-Goals

**Goals:** keep the discovered `pending` layer of a seeded session current for both runners; reconcile without ever downgrading recorded results or approvals; never mutate tree state mid-run; coalesce bursts into one listing; degrade without affecting run controls; dispose cleanly; no new dependencies or public surface.

**Non-Goals:** manual refresh control or API; whole-repo/recursive watching (node_modules, inotify limits); module-graph watching of helpers outside watched roots; watching in CI/offline artifact replay; changing run streaming or persistence semantics.

## Decisions

### 1. New `src/server/test-file-watcher.ts`; reconciliation and the session live in `discovered-tests.ts`

No existing module covers filesystem watching — `fs.watch` appears nowhere in `src/` — so a small watcher module owns root management, event filtering, debounce, and disposal. Everything that already reasons about discovered entries (`mergeDiscoveredTests`, `withoutDiscoveredTests`, runner dispatch) stays in `src/server/discovered-tests.ts`, extended with a discovery session that owns the serialized refresh pipeline and calls the watcher. The per-runner modules keep parse/synthesize only.

### 2. Watched roots derive from the latest listing (self-expanding), plus config and project root

After every successful listing the session computes roots: the run context's config file, each listed test file's directory (deduplicated; recursive where supported), and the run context's `cwd` non-recursively so a newly created top-level test directory is noticed. Each listing therefore widens the watch set as the project grows. Alternatives rejected: whole-repo recursive watch (node_modules churn, Linux inotify watch limits, unreadable on large repos), polling with timers (latency and wakeups), chokidar/Vite's watcher (new dependency; Vitest server does not run inside this process).

Recursive watch is attempted per directory; if the runtime rejects it (`ERR_FEATURE_UNAVAILABLE_ON_PLATFORM` or similar), that directory is watched non-recursively instead and the server logs one line. New files land in listed directories either way; files created in brand-new *sub*directories are picked up by the next re-enumeration, which then watches their directory. A directory created and populated between two listings (for example by a scaffolding command) is best-effort: the next change or run reconciles the tree.

### 3. Event filter and debounce

Events under generated-artifact locations are ignored: dependency/VCS/build output (`node_modules`, `.git`, `dist`, `coverage`), the report and screenshot outputs, and runner snapshot directories (`*-snapshots`, `__screenshots__`). Thus an update run writing snapshots or an approval copying baselines cannot schedule re-listings. Every other change under a watched root marks the tree dirty; a ~300 ms trailing debounce collapses bursts into one listing. No extension heuristic is needed because roots are already scoped to test directories.

### 4. Reconcile = drop the stale discovered layer, then merge the new listing under recorded results

`reconcileDiscoveredTests(reportData, discovered)` removes every `discovered:`-prefixed entry and then reuses `mergeDiscoveredTests`, which fills only identities the report does not already know. Outcomes: renamed/deleted tests lose their placeholders; tests with recorded results keep them and never get a duplicate placeholder; newly listed tests appear `pending`; loaded report state is untouched. Alternatives: additive merge (stale placeholders survive forever) and full tree rebuild (would discard loaded report results, violating run-lifecycle scoping).

A successful listing that returns zero entries clears the whole discovered layer (the tests are gone). Reconciliation runs only for a successful listing.

### 5. Listing failures become distinguishable from empty projects

`runVitestList` and `runPlaywrightList` change from `Promise<Entry[]>` to a result discriminating success from failure (non-zero exit, unparseable stdout, spawn error, timeout). Startup seeding keeps today's behavior — failed and empty listings both log one line and leave the tree/controls alone — while refresh reconciles on success only, so a broken config mid-session never erases a valid pending tree, and a genuinely emptied project does.

### 6. Run deferral is event-driven through a run-settlement hook

While `reportData.isRunning` is true, a dirty tree is queued, never applied. The session exposes `notifyRunSettled()`; `app.ts` installs it as a run-settlement callback on the routes context, `server-factories.ts` forwards it to the `RunController` (called from `handleChildExit`) and `handleRunEnd` invokes it after `finalizeRunEvent`. Both settlement paths trigger one queued reconciliation; no polling, and neither the run controller nor handlers learn about discovery beyond the callback.

### 7. Serialized pipeline

One re-enumeration runs at a time; a dirty flag produced during the in-flight listing or during a run is coalesced into a single follow-up pass after the current one settles. This bounds listing spawns regardless of edit rate and guarantees the tree always reflects a listing that started after the last observed change.

### 8. No new dependencies, no public-surface change

`fs.watch` is built into the supported runtimes; no package is added. The watcher and session stay internal — no new exports, `ServerOptions` unchanged, CLI flags unchanged, exports map / bin / peer dependencies / dist layout untouched. Watching activates exactly when a run context is seeded, mirroring the existing discovery behavior. Docs change: README.md discovery section and the example project READMEs that describe the startup-only list.

### 9. Tests use real temp projects plus injectable watcher seams

App-level tests mirror `tests/vitest-discovery-app.test.ts` and `tests/playwright-discovery-app.test.ts`: temp projects under `tests/fixtures/`, real listings, real file writes, `waitFor` on `/api/report`. Watcher unit tests inject a fake watch function for filter, debounce, coalescing, and disposal assertions, and use real directories for root computation. Run-in-progress deferral is faked by driving `run-begin`/`run-end` over `handleWebSocketMessage`.

## Risks / Trade-offs

- [A new top-level test directory created and populated within one debounce window may be missed until the next change or run] → best-effort by design; project root is watched non-recursively and the next listing widens roots.
- [Recursive watch unavailable on some Bun/Linux combinations] → non-recursive fallback per directory with one log; new files in listed directories still refresh.
- [Large test trees can exhaust inotify watches] → roots are only directories named by the listing; a watch failure degrades to startup-only discovery plus one log, never a crash.
- [~1 s listing spawn per burst] → debounce plus serialization caps it; the UI stays interactive because the pipeline is fire-and-forget.
- [Refresh cannot see helper edits outside watched roots] → documented non-goal; helpers inside test directories are covered.
- [A deleted test's recorded result persists until the next run] → consistent with `run-lifecycle` scoping; refresh only owns the discovered layer.

## Migration Plan

Not applicable — no data, config, or artifact migration. Reverting the change restores startup-only discovery without state implications.

## Open Questions

_None._
