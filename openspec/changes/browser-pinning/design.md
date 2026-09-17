## Context

See `proposal.md - Why`. Constraints that shape this design:

- A Playwright reporter receives the resolved `FullConfig`/`FullProject` and can read `project.metadata` (`{ [key: string]: any }`) once per test via `test.parent.project()` (already used in `src/reporter.ts:123,180`). It cannot modify how Playwright launches browsers.
- The installed Playwright already knows its browser builds: `playwright-core/browsers.json` carries `revision`, `browserVersion`, and platform `revisionOverrides`; `BrowserType.executablePath()` (exported by `@playwright/test`) returns the effective executable path, whose directory embeds the effective revision, without launching a browser.
- Docker mode mounts the project and runs `npx playwright test` (`src/server/docker-launcher.ts:158,172`), so the project's installed Playwright wins and the image tag is derived from that same installed version (`src/server/docker-support.ts:72`, version reader at `:217-224`).
- The CLI is currently `crvy-rprtr [artifact-dir] [options]` (`src/cli.ts`), so a subcommand group has to coexist with artifact-dir mode.

## Goals / Non-Goals

**Goals:**

- One declaration surface for pins that cannot drift from the project that actually runs.
- Offline, side-effect-free validation at reporter runtime.
- Resolution of human version prefixes to concrete builds and Playwright releases for setup, using a cached remote map.
- Provenance carried through every output surface, backwards compatible.

**Non-Goals:**

- Any change to how Playwright launches browsers, or to snapshot path resolution.
- Network access in the reporter or server runtime paths.
- Locking exact builds in config; the effective build is recorded, never written back.

## Decisions

### 1. Pins live in Playwright project `metadata`, validated with Zod

`metadata.crvyRprtr = { browser, version }`, with config-root metadata as fallback for projects without their own pin. Alternatives rejected: a reporter-option map keyed by project name (duplicates project names, drifts), a new rprtr config file (new discovery surface in sync with `playwright.config.ts`), dynamic config loading in the reporter (reporter never needs it — Playwright already hands it the project). Metadata is untyped, so the shape is a Zod schema validated at reporter init; invalid pins fail with the project name and offending value.

### 2. One shared prefix matcher module

New module (`src/browser-pins.ts`); no existing module covers version-prefix semantics. Matching is segment-wise with exact provided segments: `147` and `147.0` match `147.0.7727.15`, `147.0.77` does not. Alternatives rejected: semver ranges (users pin renderers, not dependencies), revision pins (not user-facing), string `startsWith` (false positives like `147.0.77`).

### 3. Effective build from public Playwright APIs

For each pinned project, resolve the engine's effective revision from `executablePath()` and map it to a version through the installed manifest. When a platform `revisionOverride` moves the effective revision away from the manifest default (observed for `webkit`: `mac14`, `debian11`, `ubuntu20.04` in Playwright 1.59.0), the manifest has no version for that build → status `unverifiable`, never drift. Alternatives rejected: launching the browser for `version()` (not possible in a reporter), reimplementing Playwright's platform-key logic (fragile), Playwright internals (unsupported).

### 4. Provenance is run-level, additive, and optional

A per-run `environments` map keyed by project (Playwright version, browser version, revision, Docker image, status) travels with the run: added as an optional field to the WebSocket `sync` payload, the report state (`src/report-state.ts`), `report.json` schema (`src/schemas.ts`), the static artifact (`src/report-artifact.ts`), and offline reports (`src/offline-reports.ts`). Alternative rejected: duplicating the environment on every `TestData` (thousands of tests per report), and a new WebSocket message type (extra protocol surface for the same data). Schemas parse additively permissively so older artifacts load with status `unknown` and a newer reporter against an older server degrades instead of failing.

### 5. Policy defaults to warn; strictness is explicit

`browserPinPolicy: 'warn' | 'fail'` joins `CrvyRprtrOptions` (`src/reporter-helpers.ts:6-15`); `warn` annotates drift and keeps tests running. `fail` fails the run at reporter init with a diagnostic naming project, pin, effective build, and remedy. `unverifiable` and `unpinned` never fail. CI strictness without touching the test run comes from the CLI check below. Alternative rejected: hard-failing by default (a reporter must not turn green tests red for provenance).

### 6. CLI resolution uses a cached build map; runtime never fetches

`crvy-rprtr browsers list|resolve|check`. `list` and `resolve` use `broverdev/playwright-builds` as the primary reverse index (one cached fetch), and fall back to probing recent stable Playwright versions' `browsers.json` from jsDelivr when a prefix is newer than the stale index. Stable releases only unless `--all`; ambiguous prefixes recommend the newest build and list alternatives. Cache lives in the user cache directory with a TTL and an explicit refresh escape hatch. `check` needs no network at all. Alternatives rejected: vendoring a snapshot (stale + packaging pipeline), per-version probing only (N requests), the full npm registry document (tens of MB). No new dependency: `fetch`, `fs`, and the existing path utilities cover it.

### 7. `browsers check` reuses Playwright's config loading

`check` spawns the project's own `playwright test --list --reporter=json` and reads pins from the serialized `config.metadata` and `config.projects[].metadata` (the built-in JSON reporter already emits project metadata — `playwright/lib/reporters/json.js:73`), then evaluates them against the installed environment offline. This handles TS configs and project resolution exactly like a real run. Alternatives rejected: dynamically importing the config ourselves (needs a TS loader — new dependency), reading the last run's artifacts (post-run only; does not support the pre-flight use case), shipping a custom injected reporter (extra built entry point). A "no tests found" exit from `--list` is tolerated as long as the JSON config section parses.

### 8. Docker preflight, no artifact mutation

The Docker run path reuses the existing installed-version reader and image derivation; a pin the installed version cannot satisfy rejects the run before a container starts and names the matching image tag. Validation never writes baselines or snapshot paths; the shared installed-version reader moves into the new module rather than being duplicated (jscpd guards duplication).

### 9. Published surface impact

- Reporter options gain `browserPinPolicy` (documented in `README.md`).
- CLI gains a `browsers` group; artifact-dir positional mode is unchanged; no change to the `bin` mapping.
- `package.json` `exports` map unchanged; no new runtime dependency; peer dependency on `@playwright/test` unchanged.
- `dist/` gains the shared pin module and CLI code; report artifacts gain optional fields only.

## Risks / Trade-offs

- [Stale third-party build map misses a recent Playwright release] → probe fallback for recent versions; runtime validation never depends on the map; clear diagnostic when resolution fails offline.
- [Prefix pins feel stronger than they are: `26` matches several WebKit builds] → provenance records the exact build and revision; `resolve` lists alternatives; docs explain constraint vs lock.
- [Platform overrides and channel/executablePath projects are unverifiable] → explicit status, never drift; never fails under `fail`.
- [Metadata is untyped in Playwright configs] → Zod validation at init with project-named errors.
- [Additive protocol fields against an older server] → permissive schema parsing; older artifacts load with `unknown` status.
- [No baseline provenance: bumping a pin re-compares old baselines under a new build] → documented workflow; drift badge plus exact build make the cause visible; sidecar files remain a non-goal.

## Migration Plan

Additive: existing configs (no metadata) yield `unpinned`/`unknown` and unchanged behavior. Ship in a minor release with docs updates (`README.md`, `docs/docker-screenshot-determinism.md`, `docs/text-antialiasing-determinism.md`, plus a creevey `browserVersion` migration note). Rollback is removing the metadata/policy; no user data or artifact migration is required.

## Open Questions

- Cache TTL default and refresh flags for `browsers list|resolve` (e.g. 24h + `--refresh`).
- Exact UI placement of the pin badge (run header vs project node in the tree).
