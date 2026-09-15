## Context

The UI is gated twice, and both gates are closed for Vitest at server start: `reportData.tests` is empty until a run (or a persisted report) fills it — an empty sidebar renders "No tests match filter" (src/client/components/Sidebar.svelte) — and `runContext` is seeded at startup only from a Playwright config (`seedRunContext`, src/server/app.ts), while Vitest run contexts arrive only when the reporter registers mid-run (src/server/handlers.ts). The `test-runner` capability (vitest-runner change) fixed the register path; this change closes the startup path.

Verified facts shaping the design:

- `CI=true vitest list --json` enumerates tests in ~0.9s without launching the browser, emitting flat entries `{ name, file, projectName }` (no line numbers, no suite nesting). Without `CI=true`/closed stdin it hangs in interactive mode — server-side spawns must guard both.
- The client state machine already knows `pending` (src/client/helpers/status.ts), so discovered tests render with zero client/wire changes.
- Playwright has no pre-run listing anywhere (run-controller's `--test-list` is a rerun filter), so this is a Vitest-only capability for now.

## Goals / Non-Goals

**Goals:** one-time, async startup discovery in a Vitest project: run controls enabled from the discovered config alone, sidebar pre-populated with discovered tests as `pending`, merge-under-loaded-report semantics, clean replacement by the first real run.

**Non-Goals:** Playwright listing parity; refresh/file-watching re-discovery; per-test rerun precision; any CLI flag or client change (see proposal).

## Decisions

### 1. Discovery spawns the project's own `vitest list`, resolved like runs are

`vitest-discovery.ts` spawns `vitest list --json` with `CI=true`, stdin closed, captured stdout, and a kill timeout, resolving the binary through the same package-manager resolution run-launcher uses (`resolveLocalCommand`/`package-manager-detector`), so bun/pnpm/npm projects and the container's node fallback behave identically to UI-launched runs. Alternatives rejected: the programmatic Vitest API (imports `vitest/node` into the server process — couples the runtime to the peer dep and runs Vitest in-process); parsing the config's `include` globs statically (misses suite/test structure and dynamic names).

### 2. Buttons and tree decouple: config discovery seeds the run context; a successful listing seeds the tree

`seedRunContext` extends to discover `vitest.config.{ts,js,mts,mjs,cts,cjs}` and seed `{ runner: 'vitest', configFile, cwd }` — same trust level as Playwright's config-path seeding (no execution). The listing runs asynchronously afterwards; if it fails (broken config, missing deps, zero tests) the buttons stay enabled and the sidebar keeps its loaded state, with one log line. A run attempt then surfaces the real error through the existing run-failure path.

### 3. Playwright discovery keeps precedence

If a `playwright.config.*` is discovered (or `--config` given), the server seeds Playwright and skips Vitest discovery. Two seeded runners would make run-button semantics ambiguous; existing behavior wins.

### 4. Tree synthesis mirrors streamed grouping

Discovered entries are synthesized into the same suite/test tree streamed results produce: suites from the test file path (relative to the Vitest root), `pending` status, browser taken from `projectName` when it maps to one (reusing `getBrowserName`), and a `discovered:`-prefixed test id so provenance is explicit. Identity for merge/dedup is `(file, full title path)` — stable across runs, unlike runtime task ids.

### 5. Merge under the loaded report; replace on run; never persist

After `loadOfflineReports`/report.json restore, discovered entries fill only identities the report does not know (loaded results are never downgraded to `pending`). When a run begins, all `discovered:`-prefixed entries are dropped before streamed events land, so stale identities vanish. `saveReport` filters `discovered:` ids out, keeping report.json, offline JSON review, and the static HTML artifact event-derived — satisfying the spec's persistence scenarios with one filter point.

### 6. No new dependencies, no public-surface change

Child-process spawn, Zod parsing of `vitest list --json` output, and the existing tree types cover everything; the published exports map, CLI flags, and peer deps are untouched. Discovery executes the project's config and test files (collection) — the same trust boundary as UI-launched runs, scoped to servers started inside a Vitest project.

## Risks / Trade-offs

- [Discovery snapshot goes stale] → the list reflects discovery time; edits mid-session aren't picked up until the next run replaces the tree. Accepted for v1 (spec: no refresh affordance).
- [~1s async spawn per server start in Vitest projects] → fire-and-forget after listen; the UI is interactive immediately and the tree appears when ready.
- [Flat `list` output lacks line numbers] → per-test rerun keeps the existing `-t` approximation; no precision regression.
- [`projects`/multi-browser configs emit duplicate names per project] → grouped under the file with the project-derived browser label; worst case a test appears once per project, matching how streamed results distinguish them.
- [Broken configs log noise at startup] → single `console.error` with the exit reason; no crash, no retry loop.

## Open Questions

_None._
