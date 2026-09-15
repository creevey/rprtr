# Proposal: vitest-discovery

## Why

Starting the UI server in a Vitest Browser Mode project shows an empty sidebar ("No tests match filter") and no run controls until a first terminal run registers the reporter. Playwright projects get run buttons at startup via config discovery; Vitest users get neither buttons nor a test list, so the UI looks broken exactly when someone tries the documented workflow. This surfaced while dogfooding the `vitest-browser-example`.

## What Changes

- Server startup discovers `vitest.config.*` in the working directory (mirroring the existing `playwright.config.*` discovery in `seedRunContext`, src/server/app.ts) and seeds a Vitest run context — sidebar run controls (Start/Stop) are enabled without any prior run.
- Seeding additionally spawns `CI=true vitest list --json` (verified: ~1s, does not launch the browser) and synthesizes the discovered tests into the report tree as `pending` entries, so the sidebar lists what would run before anything ran.
- Discovered pending tests are server-session state: they fill only the gaps in a loaded `report.json` (real results always win), are replaced wholesale when a real run streams, and are excluded from persisted reports.
- No reporter, client, or wire-format changes — the client already renders `pending` tests, and `runner: 'vitest'` registration semantics are unchanged.

## Capabilities

### New Capabilities

_None._ The work extends the existing `test-runner` capability (introduced by `vitest-runner`): same subsystem — how the server learns what to launch and what the UI shows before/during runs. Without extending it, Vitest projects keep a button-less, empty UI at server start; the capability's stated goal ("re-run tests from the UI for any supported runner") is only met after a manual first run.

### Modified Capabilities

- `test-runner`: the "Startup discovery remains Playwright-only" scenario is replaced — startup discovery now also accepts Vitest configs and seeds both the run context and a pre-run test tree; a new requirement defines discovered-test semantics (pending status, merge-over-report, replacement on run, exclusion from persisted reports).

## Impact

- **Server**: `src/server/app.ts` (seeding), new `src/server/vitest-discovery.ts` (spawn + parse + tree synthesis — colocated beside run-controller), report-state seeding point, `saveReport` exclusion.
- **Unchanged surfaces**: reporter, client components, wire schema, CLI flags, public exports (`./server` types gain no new surface unless the programmatic API passes options through).
- **No new dependencies** — spawning uses the existing child-process pattern from run-launcher; parsing is plain JSON + Zod (stack already covers it).
- **Docs**: main README run-buttons section; `examples/vitest-browser/README.md` limitation/FAQ lines that describe the first-run-to-enable flow.
- **Note**: discovery executes the project's vitest config and test files at server start (collection) — accepted, matching how Playwright-based workflows already execute the project's tooling; rationale in design.md.

## Non-goals

- **Playwright pre-run test listing** — the same gap exists there (`playwright test --list --reporter=json`), but this change ships the Vitest half; parity is a separate change.
- **Refresh/re-discover affordance** — the list reflects discovery time; a real run replaces it. A refresh button is deferred.
- **File watching** — no re-discovery on config/test edits during a server session.
- **Per-test rerun precision** — the existing `-t` title-pattern approximation is unchanged.
