# Proposal: playwright-pre-run-listing

## Why

Playwright projects started with the crvy-rprtr server still show an empty sidebar until the first run streams: the run-begin announcement only exists once a run starts. The `vitest-discovery` change shipped the pre-run listing for Vitest and explicitly deferred the Playwright half in its Non-goals ("Playwright pre-run test listing — the same gap exists there (`playwright test --list --reporter=json`)"). Playwright users get run buttons from config seeding but no test tree, so they cannot see or select what will run before running it.

## What Changes

- Server startup, when it seeds a Playwright run context (discovered `playwright.config.*` or CLI `--config`), also spawns the project's own `playwright test --list --reporter=json` and synthesizes the listed tests into the live report tree as `pending`, grouped by test file exactly like streamed results (same file tokens, describe title path, browser label, location).
- The same discovered-entry semantics as Vitest apply: entries fill only gaps in a loaded report, are replaced by the first real run (streamed results take over their tree slot; run end culls the rest), and are never persisted to `report.json`, offline JSON review, or the static HTML artifact.
- A failing Playwright listing (broken config, missing dependencies, no tests, timeout) keeps the run controls enabled, leaves the sidebar state untouched, and logs one line without crashing the server.
- No reporter, wire-format, client, CLI-flag, or public-export changes: the existing `pending` rendering and persistence filter cover Playwright.

## Capabilities

### New Capabilities

_None._ The work extends the existing `test-runner` capability, whose pre-run discovery requirement was written for Vitest only. Without this change Playwright projects keep the empty pre-run sidebar the Vitest change documented as a gap; the capability's goal — run controls and a visible test tree before any run — stays half met.

### Modified Capabilities

- `test-runner`: the requirement "Pre-run Vitest test tree discovery" becomes "Pre-run test tree discovery" and covers both runners — a discovered Playwright project now lists its tests at startup instead of keeping an empty pre-run tree, and the failing-listing behavior is stated for both config kinds.

## Impact

- Server: `src/server/app.ts` startup wiring; new Playwright listing parse/synthesis beside `src/server/vitest-discovery.ts`; `src/server/vitest-seeding.ts` dispatch and the shared `discovered:`-entry machinery (`src/report-state.ts` placeholder removal and `withoutDiscoveredTests` already apply unchanged); `src/project-pins.ts` already spawns `playwright test --list --reporter=json` for pins and is the reuse point for the spawn.
- Unchanged surfaces: reporter, Svelte client, wire schema, CLI flags, public exports (`.`, `./server`, `./rendering`, `./types`).
- No new dependencies: the existing child-process spawn, Zod parsing, and tree types cover it.
- Docs: README.md "Server CLI Options" and the Vitest run-buttons section gain Playwright parity; no `docs/*.md` page behavior changes.
- Tests: new Playwright listing unit tests plus startup seeding coverage mirroring `tests/vitest-discovery*.test.ts`.

## Non-goals

- Re-discovery/refresh or file watching — the list reflects server start; the first real run replaces it.
- Discovery after reporter registration — parity with Vitest keeps this startup-only; registering reporters keep streaming semantics.
- Per-test rerun precision — the existing Playwright positional/`--test-list` selection is unchanged.
- Vitest behavior changes — its listing path is unchanged apart from sharing the extracted machinery.
- New CLI flags.
