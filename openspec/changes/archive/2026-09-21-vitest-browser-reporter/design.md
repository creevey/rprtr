# Design: vitest-browser-reporter

## Context

See proposal. The server's current model (post-docker/portable-artifacts work): reporters send native attachment paths + `visualDeclarations`; the server serves provider files via `/file/<abs-path>` restricted to `artifactRoots`, re-derives Playwright baseline paths server-side (`snapshot-path-resolver.ts`), and approval copies resolved baselines. Three run modes exist: dev (live server, zero reporter-side persistence), CI (reporter defers to run end, content-addressed copies, static HTML + offline JSON), docker (container→host path rewriting). A validated spike (PR #2) established the Vitest integration mechanics; this design re-derives it against the current architecture, not the spike's copy-into-screenshotDir model.

Depends on `extract-reporter-transport` landing first: the Vitest reporter consumes the same transport lifecycle (`start`/`send`/`finish`) as the Playwright adapter.

## Goals / Non-Goals

**Goals**

- One new reporter consuming the shared transport; Playwright reporter untouched.
- Dev mode: zero reporter-side I/O for screenshots; server serves Vitest's own files.
- CI mode: byte-portable static HTML + offline JSON (same guarantees as Playwright).
- First-run baseline display working end to end.

**Non-Goals**

- Approval (`approvalTargets` reserved by name in the payload design, unimplemented — follow-up change).
- UI-triggered runs, docker, declaration synthesis, custom Vitest path resolvers (see proposal).

## Decisions

### D1: Zero-copy dev mode via renamed attachment entries

Vitest artifacts are named `reference`/`actual`/`diff` (no screenshot prefix; `reference` ≠ `expected`), so the server's image grouper cannot consume them directly. The reporter emits renamed entries — `{ name: '<image>-expected.png', path: <vitest reference abs path> }`, likewise `-actual`/`-diff` — keeping Vitest's native absolute paths.

- Existing pipeline consumption verified: `attachmentsToImages` groups by the `^(.+?)-(actual|expected|diff)$` name convention and maps absolute paths to `/file/<encoded>` URLs; first-run reference-only entries yield `baseline-only` classification with no extra code.
- Alternative (spike's approach: copy into `screenshotDir` in dev too) — rejected: duplicates the persistence model main moved away from, adds I/O, and breaks the "server reads provider files" property docker-mode path mapping relies on.

### D2: Register-time allowlist extension

`RegisterDataSchema` gains optional `vitestAttachmentsDir` (+ `vitestReferenceDir`); `handleRegister` pushes present values into `artifactRoots`, mirroring `playwrightSnapshotDir`/`playwrightTestDir` handling. The `/file/` route's symlink-safe containment check applies unchanged.

- **Trade-off, stated**: Vitest scatters `__screenshots__/` across the test tree, so allowlisting the Vitest root is project-tree-broad. Precedent: `playwrightTestDir` is already registered today; threat model is a localhost dev server. Narrower roots (per-test-file dirs) would require per-event root registration — deferred until a need appears.
- `/baseline/` is not extended for Vitest: it is resolver-derived trust tuned to Playwright templates; adding a Vitest branch pollutes a module that just stabilized (same reasoning as deferring approval-resolution changes).

### D3: CI mode reuses the Playwright persistence ops, not new code

At run end (offline/CI), the reporter copies artifacts via `saveAttachments` (content-addressed names) and the reference via the baseline-copy op, replacing attachment paths with relative content-addressed paths before writing events. This is not optional polish: the static HTML artifact cannot fetch absolute `/file/` URLs over `file://`, so relative paths are what make the static surface work. Deferral buffering mirrors the Playwright adapter's `pendingArtifacts` pattern minus `ResolvedBaselineTarget` (Vitest's reference path is already known; no resolver round-trip).

### D4: Artifact location discovery — layered, defensive

Order of resolution per screenshot (from the spike, re-verified against current Vitest docs): artifact attachment paths → ANSI-stripped error-message parsing (`Reference screenshot:`/`Actual screenshot:`/`Diff image:` lines) → reconstructed default layout paths (`<root>/<testFileDir>/<referenceDir|attachmentsDir>/<testFileName>/<name>-<browser>-<platform>[-<role>].png`). Vitest's `toMatchScreenshot` is a documented, first-class feature, but artifact internals (`internal:toMatchScreenshot` artifact type, message wording) are private and churned as recently as early 2026 — hence the layered fallbacks and a live integration test that pins current behavior. All parsing lives in one module (`vitest-helpers.ts`) so a Vitest-version bump touches one file.

### D5: `provider` field on events

Optional `provider: 'playwright' | 'vitest'` on `test-begin`/test data, Zod-optional, defaulting absent = playwright. Purpose: report-state provenance and future UI badge; approval (follow-up) keys off metadata, not provider, so this is informational.

### D6: Package surface

`exports` map gains `"./vitest"` → `dist/vitest.js` (+ `.d.ts`); `build.ts` adds the entry; peerDependencies gains `vitest: ">=4 <5"`; devDeps gain `vitest` + `@vitest/browser-playwright` (justified: the integration test runs a real browser-mode suite; no existing stack provides Vitest runtime). `tsconfig.json` strictness untouched — the spike's weakened tsconfig is explicitly not carried over.

## Risks / Trade-offs

- [Vitest private-artifact churn breaks discovery] → Mitigation: D4's layered fallbacks; single parsing module; integration test against pinned current Vitest acts as an early-warning tripwire.
- [Error-message regex coupling to Vitest wording] → Mitigation: reconstruction fallback (D4) degrades to default-layout paths rather than nothing; tests assert all three layers.
- [Allowlist breadth (D2)] → documented trade-off; narrow when a concrete need appears.
- [Two providers in one process type-checking against different reporter type universes] → Vitest reporter imports `vitest/node` types only in `src/vitest.ts`/`vitest-helpers.ts`; no shared types cross the boundary; esbuild bundles entries independently.
- [First-run behavior differences across Vitest versions (message wording, artifact presence on pass)] → integration fixture includes a first-run case; discrepancies surface as test failures, not silent UI gaps.

## Migration Plan

Additive release: new export subpath, optional peer dep; consumers unaffected until they opt in. Server accepts old register payloads (all new fields optional). Rollback = revert; no data migration. Old offline reports replay unchanged (no schema removals).

## Open Questions

- Whether `vitestReferenceDir` registration is separately needed or derivable from the Vitest root — settles during implementation against the allowlist containment check; does not affect payload shape or tasks.
- Exact CI flush ordering for mixed Playwright+Vitest repos (separate offline JSON files already; no conflict expected) — verified by the offline suite, not a design blocker.
