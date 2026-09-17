## Why

Screenshot baselines are only comparable when the rendering browser build is identical, and a Playwright upgrade silently changes the bundled browser revision — producing mass diffs that rprtr today cannot distinguish from real regressions. The reporter derives the environment from the installed Playwright version only (docker image tag at `src/server/docker-support.ts:72`) and reports nothing about the browser build that produced a screenshot. Users migrating from creevey have no way to declare "these baselines belong to Chromium 147" and have the tool check it. Without this capability, browser upgrades keep landing as unexplained diff noise and the review UI cannot say whether a change is rendering drift or a genuine regression.

## What Changes

- Declare a browser pin on a Playwright project: `metadata.crvyRprtr = { browser: 'chromium', version: '147' }` — the version is a segment prefix (`147`, `147.0`, or a full version), validated at reporter init.
- The reporter resolves the effective browser build from the installed `playwright-core/browsers.json` (honoring platform `revisionOverrides`) and emits environment metadata (Playwright version, browser name/version/revision, docker image) with the run.
- Pin status (pinned / drift / unpinned / unverifiable) is surfaced in the live UI, the static HTML artifact, and offline JSON reports.
- New CLI subcommands: `crvy-rprtr browsers list`, `resolve <engine>@<prefix>` (prefix → concrete build + required Playwright version + fix command), and `check [--strict]` (offline validation for CI).
- `browserPinPolicy: 'warn' | 'fail'` reporter option; `warn` is the default.
- Docs: the pin contract is added to the determinism docs, with a creevey `browserVersion` migration note.

## Capabilities

### New Capabilities

- `browser-pinning`: declare per-project browser version-prefix pins, resolve them against the published Playwright build map, validate them against the actual run environment, and report provenance and status across the live UI, static HTML, offline JSON, and CLI.

### Modified Capabilities

- None (no capability specs exist under `openspec/specs/` yet).

## Impact

- Code: `src/reporter.ts` (environment capture + payload), `src/types.ts` / `src/schemas.ts` (environment fields), a new pin-resolution/validation module, server artifact and report-persistence paths, client badges, `src/cli.ts` subcommands, `src/server/docker-support.ts` preflight.
- Published surface: reporter options gain `browserPinPolicy`; the CLI gains a `browsers` command group; package `exports` unchanged; no new runtime dependency.
- Docs: `docs/docker-screenshot-determinism.md`, `docs/text-antialiasing-determinism.md`, `README.md`.
- Determinism: snapshot path resolution is untouched; validation only annotates artifacts, never rewrites baselines.

## Non-goals

- Custom browser executables (`executablePath`, CfT downloads) and stock Firefox/WebKit — Playwright supports only its bundled builds.
- Automatically changing the project's `@playwright/test` version or rewriting `package.json`.
- Baseline provenance sidecar files next to snapshots.
- Vitest reporter parity (fast-follow).
- Pinning by revision numbers, or matching pre-release Playwright versions during resolution.
- Blocking approvals based on pin status.
