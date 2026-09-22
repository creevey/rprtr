# Design: playwright-pre-run-listing

## Context

See `proposal.md` — Why. The Vitest half of pre-run listing already exists and is the pattern to mirror:

- `src/server/vitest-discovery.ts` spawns `vitest list --json` through `resolveLocalCommand`, parses entries with Zod, and synthesizes `TestData` with a `discovered:`-prefixed id; `src/server/vitest-seeding.ts` dispatches it at startup and filters discovered ids out of `saveReport` via `withoutDiscoveredTests`.
- `src/report-state.ts` already owns the runner-neutral takeover path: `removeDiscoveredPlaceholder` swaps a `discovered:` entry for the streamed test that occupies the same tree slot (file tokens + title path + title + browser), and `finalizeRunEvent` culls entries that never ran. The Svelte client already renders `pending` tests (`isTreeVisible`).
- `src/project-pins.ts:readPlaywrightListReport(cwd)` already spawns the exact command this change needs — `playwright test --list --reporter=json` — with a 60s kill timeout, and parses stdout JSON. It currently passes no `--config`.

Playwright's JSON list report (verified against Playwright 1.59, `lib/reporters/json.js`) carries `config.rootDir`, `config.projects[]` (name, metadata), and per-file `suites[]` with nested describe suites; each spec has `title`, `location` relative to `rootDir`, a real `id`, and one `tests[]` entry per project carrying `projectName` and `status`. Listing is a collection pass: it loads the config and test files but executes no tests.

Constraints: strict TypeScript, Zod at external-input boundaries, `bun test` from `tests/`, no new dependencies, no public-surface change (`package.json` exports, bin, `dist/` layout, `@playwright/test` peer dependency).

## Goals / Non-Goals

**Goals:**

- A Playwright config-seeded server lists its tests at startup and renders them as `pending` in the same tree slots streamed results will occupy.
- Reuse, not duplicate: the discovered-entry machinery, persistence filter, and takeover path stay single-sourced.
- Failure of the listing is invisible to run controls and loaded report state, with one log line.

**Non-Goals:**

- Re-listing after a reporter registers, on config changes, or via a UI refresh (startup-only parity; see proposal Non-goals).
- Unifying the Vitest and Playwright report parsers — their input shapes differ; only the neutral machinery is shared.
- Changing the run-begin announcement, the reporter, the wire schema, the client, or CLI flags.
- Precise takeover for unnamed Playwright projects whose browser comes from `use.browserName`/`use.defaultBrowserType` (see Risks).

## Decisions

### 1. Enumerate through `playwright test --list --reporter=json`, reusing the pins spawn

Extend `readPlaywrightListReport(cwd)` in `src/project-pins.ts` with an optional config path that appends `--config <path>`, so a server started with `--config` outside the working directory lists the configured project, and with an optional spawn seam (mirroring `vitest-discovery.ts`) so failure modes are unit-testable without launching Playwright. A new `src/server/playwright-discovery.ts` wraps it as `runPlaywrightList` and owns parsing and synthesis.

Alternatives rejected: parsing the human-readable `--list` output (no machine contract, paths relative to `testDir`, no ids or columns); importing Playwright's programmatic API (adds `@playwright/test` as a server runtime import when it is only a consumer peer dependency; the pins reader already proves the spawn path works).

### 2. Synthesize discovered entries with the existing `discovered:` id scheme

For each file suite → spec → project test entry, synthesize one `TestData`: `fileTokens` relative to `dirname(configFile)` (the reporter's `configDir`), `titlePath` from the nested describe suite titles, `title` from the spec, `browser` from the project name, `location` absolute (resolved from `config.rootDir`), `provider: 'playwright'`, `status: 'pending'`, and `id: discovered:<relativeFile>:<browser>:<full title path>`, matching the Vitest id shape.

Alternative considered: use Playwright's real `spec.id`, which is stable across runs and identical to the runtime `test.id` the reporter streams. That would make takeover an exact id match, but it breaks the provenance contract: `withoutDiscoveredTests` (persistence) and `removeDiscoveredPlaceholder` both key on the `discovered:` prefix, so real ids would need a parallel discovered-id set threaded through report state, persistence, and test-begin. The synthetic id keeps one provenance mechanism for both runners; takeover fidelity comes from the tree-slot identity the project already maintains and tests.

### 3. Extract runner-neutral machinery; add a Playwright sibling module

`src/server/vitest-discovery.ts` mixes runner-specific work (spawn, parse, synthesize) with neutral work (prefix, identity, merge). Extract the neutral pieces into `src/server/discovered-tests.ts`: `DISCOVERED_ID_PREFIX`, `discoveredTestIdentity`, `mergeDiscoveredTests` (generalized to accept synthesized `TestData[]`), `withoutDiscoveredTests`, and the startup dispatch (Vitest lister vs Playwright lister). `vitest-discovery.ts` and the new `playwright-discovery.ts` keep only their runner's spawn/parse/synthesize; `vitest-seeding.ts` keeps run-context seeding (`resolveVitestConfig`, `resolveSeedRunContext`) and loses the discovery exports.

The existing module that covers this need is `vitest-discovery.ts` — its neutral parts move rather than being copied, so the new module is a relocation plus one new runner-specific file, not a parallel implementation.

### 4. Startup dispatch mirrors the Vitest path

`src/server/app.ts` generalizes `startVitestDiscovery` to dispatch on `runContext.runner` (`undefined` resolves to Playwright, as elsewhere), fire-and-forget after the report loads, with the same `.catch` logging. A failed or empty listing adds nothing, logs one line (`[PlaywrightDiscovery] …`), and never touches run controls or loaded results. The listing keeps the pins reader's 60s timeout.

### 5. No client, wire, reporter, CLI, or public-surface change

`sync` broadcast, `pending` rendering, placeholder takeover, and `saveReport` filtering already cover a second provider. No export is added to `.`, `./server`, `./rendering`, or `./types`; `dist/` layout, the bin, and the `@playwright/test` peer dependency are unchanged. Docs: README run-button sections gain Playwright parity; no `docs/*.md` behavior changes.

### 6. No new dependencies

Spawn uses the existing `resolveLocalCommand` + `node:child_process` pattern; report parsing uses the existing Zod `safeParse` helper and plain object walking; tree types already exist. Nothing in the current stack (esbuild, Svelte, ws, Zod, p-limit) is displaced.

## Risks / Trade-offs

- [Unnamed project with a non-Chromium browser: the reporter labels tests via `use.browserName`/`use.defaultBrowserType`, which the JSON list report does not expose, so discovery falls back to `chromium` and the placeholder is not swapped at test-begin] → Prefer the raw project name (exact for named projects); a full run culls leftover placeholders at run end; documented as a known parity limitation. A future listing reporter could expose `use`, but that is not needed for the common named-project layout.
- [Listing loads the project's config and test files at server start] → Same trust boundary as Vitest discovery and UI-launched runs; scoped to servers started in a Playwright project or given `--config`; a broken config yields an empty list and one log line.
- [Large suites make the listing slow] → Fire-and-forget after listen; the UI is interactive immediately and the tree appears when ready.
- [Extracting neutral code from `vitest-discovery.ts` risks a Vitest regression] → The extraction is behavior-preserving and lands first, verified by the existing `tests/vitest-discovery*.test.ts` before the Playwright path is added.
- [The pins reader gains an optional `--config` argument and spawn seam] → Existing call sites pass nothing and keep today's command; focused tests cover the argument pass-through and the failure modes.

## Migration Plan

No data or wire migration: discovered entries are server-session state and were never persisted. Ship the extraction, then the Playwright listing, in one change; rollback is reverting the commit — `report.json`, offline JSON, and the static artifact are unaffected either way.

## Open Questions

_None._
