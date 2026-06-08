# CI-Gated Screenshot Artifact Handling Design

**Date:** 2026-06-08
**Topic:** Stop duplicating screenshot artifacts in live mode, fix unnamed-screenshot naming, and gate portable copies on `process.env.CI`

## Overview

Crvy Rprtr copies screenshot images into a per-test directory tree under `screenshotDir` (`screenshots/<sanitized-test-id>/`) on every run. Two problems follow from this:

1. **Phantom duplicate images.** Unnamed `toHaveScreenshot()` declarations are assigned a synthetic name `__unnamed-screenshot-N` (`reporter-utils.ts`). Playwright, however, names its real artifacts and baselines from the auto-generated test name (e.g. `MaskedInput-Positions-1`). Because the two names never match, `mergeDeclaredImages` (`report-utils.ts`) keeps both — one real `comparison`/`baseline-only` entry plus a `declared-only` phantom keyed by the synthetic name.

2. **Wasteful, unmanaged copies.** For passing tests the reporter copies the canonical baseline into `screenshotDir` on every run, even though the bytes already exist in Playwright's `…-snapshots/` directory. Nothing prunes `screenshotDir`, so it grows unbounded and accumulates stale artifacts across reporter versions (observed: `*.png.png` and extensionless leftovers).

This design:

1. Reconciles unnamed screenshot names to Playwright's real auto-generated name, eliminating the phantom duplicate and producing human-readable filenames.
2. Gates all portable copying on `process.env.CI`. In CI, the reporter produces a self-contained artifact (copies + static HTML + offline JSON). Locally (non-CI), the reporter writes nothing to `screenshotDir`; the running server serves images directly from Playwright-native locations.
3. Removes the need for any cleanup logic by not writing to `screenshotDir` outside CI and by relying on Playwright's own auto-cleaned `outputDir`.

## User Story

As a developer running screenshot tests, I want the reporter to show exactly one image per screenshot assertion and to stop piling duplicated baseline copies into my working tree, so that the report is accurate and my repository stays clean. In CI, I want a self-contained report artifact I can archive and open without a running server.

## Background: verified facts

- **Playwright reporter lifecycle** (`node_modules/playwright/types/testReporter.d.ts`): `onBegin`, `onTestBegin`, `onTestEnd` return `void` and are **not awaited**; `onEnd` and `onExit` return promises and **are awaited**. Awaiting a connection in `onBegin` cannot gate test execution.
- **Playwright `outputDir`** (`test-results/`) is **cleaned at the start of every run**, with a unique subdirectory per test. Failure artifacts (`*-actual.png`, `*-expected.png`, `*-diff.png`) live there and are exposed as `result.attachments[].path`. Playwright manages that directory's lifecycle.
- **Unnamed screenshot naming** is reconstructed by the resolver today via `anonymousName(reporterTitlePath, occurrenceIndex)` (`snapshot-path-resolver.ts`), which already matches Playwright's auto-name. The resolver computes it to locate the source baseline, then discards it in favor of `declaration.visualName` (the synthetic name) for `attachmentBaseName`/`visualName`.
- **The static HTML report does not embed images** (`report-artifact.ts` → `buildStaticBootstrapData`): it references them by a relative path from `crvy-rprtr.html` to `screenshotDir`. A portable artifact therefore requires the copied files to exist.
- **The server already resolves baselines itself** (`server/routes.ts` → `resolveApprovalTarget` → `resolveBaselineTargets`) using the `approvalRouting` config, for approvals.

## Goals

1. Show exactly one image entry per screenshot assertion (no `__unnamed-screenshot-N` phantom alongside a real image).
2. Use Playwright's real auto-generated name for unnamed screenshots in both event data and copied filenames.
3. Write to `screenshotDir` only when `process.env.CI` is set.
4. In live (non-CI) mode, serve all images from Playwright-native locations (`outputDir` attachments and the canonical `…-snapshots/` dir) with no copying.
5. In CI mode, produce a self-contained, portable artifact (`crvy-rprtr.html` + `crvy-rprtr-<n>.json` + copied images).
6. Remove dedicated cleanup logic; inherit Playwright's `outputDir` auto-clean.

## Non-Goals

1. Probing server availability or adding WebSocket connection timeouts to decide copying. The decision is `process.env.CI`.
2. Embedding images as base64 in the static HTML.
3. Cleaning or pruning `screenshotDir` (CI workspaces are ephemeral; local runs no longer write there).
4. Changing the approval flow's baseline-resolution semantics.
5. Supporting a "local, no server, not CI" portable artifact (see Decision D1).

## Mode Detection

A single helper replaces offline/availability detection as the copy trigger:

```ts
export function isCI(env: NodeJS.ProcessEnv = process.env): boolean {
  const ci = env.CI
  return ci !== undefined && ci !== '' && ci !== 'false' && ci !== '0'
}
```

- Overridable via `CrvyRprtrOptions.ci?: boolean`, defaulting to `isCI()`, for tests and escape hatches.
- **CI = portable mode:** copy artifacts into `screenshotDir` and write the static HTML + offline JSON at `onEnd`. The WebSocket connect is skipped (no server expected).
- **Non-CI = live mode:** attempt the WebSocket connect for live updates (best-effort); write nothing to `screenshotDir`; the server serves images from Playwright-native locations.

This removes `isOfflineMode` / `hadOfflineMode` / `enableOfflineMode` as the artifact-generation trigger. The WebSocket transport itself remains for live updates in non-CI runs.

### Decision D1 (accepted)

The current "local, no server, not CI" path produces an offline artifact through WebSocket-failure detection. Under CI-gating that path produces no portable artifact (live mode assumes the server is running). This is accepted: the tool's local mode is the interactive server.

### Decision D2 (accepted)

`crvy-rprtr.html` and `crvy-rprtr-<n>.json` are generated **only in CI mode**, not on local runs. Locally the running server is the report.

## Naming Reconciliation

The reporter finalizes each declaration's `visualName` using Playwright's reconstructed auto-name before emitting events or copying:

- Expose the auto-name reconstruction from `snapshot-path-resolver.ts` (the logic behind `anonymousName`) so the reporter, which holds `reporterTitlePath`, can finalize unnamed declarations.
- Both the event payload (`visualNames`, `visualDeclarations`) and the baseline copy use the finalized name. The declared key then matches the attachment-derived key, so `mergeDeclaredImages` produces one entry.
- For named screenshots, behavior is unchanged.
- `__unnamed-screenshot-N` remains only as a fallback when `reporterTitlePath` is unavailable.
- `createResolvedBaselineTarget` for the `unnamed` case uses the reconstructed name for `visualName`/`attachmentBaseName`/`artifactBaseName` instead of the synthetic name.

This fixes the phantom duplicate for both the failing-test case and the `baseline-only` case.

## Live Mode (non-CI): Zero-Copy Serving

`onTestEnd` performs no copying. Events carry Playwright-native paths:

- Failure artifacts → `result.attachments[].path` (absolute, in `test-results/`).
- Passing baselines → no attachment; resolved on demand by the server.

Server changes (`server/routes.ts`):

- **New baseline route** `/baseline/:testId/:retry/:visualName` → `resolveBaselineTargets` → stream the snapshot from the canonical `…-snapshots/` dir. Reuses the existing `approvalRouting` config.
- **Serve failure artifacts from native absolute paths** via a route guarded by an **allowlist of permitted roots** (Playwright `outputDir`, `snapshotDir`). Paths outside the allowlist return 404, preventing arbitrary-file reads.
- In live mode, image URLs in report state point at these routes rather than `/screenshots/<relative>`.

`screenshotDir` is never written locally, so nothing accumulates and no cleanup logic is required.

## CI Mode: Portable Artifact

All copying moves to `onEnd` (awaited), driven from buffered per-test data:

- During the run, buffer per test: the `BaselineResolverInput` and the native attachment list. (Events are already buffered in `runEvents`.)
- At `onEnd`, when `ci` is true:
  1. Copy failure artifacts and resolved passing baselines into `screenshotDir/<sanitized-test-id>/`.
  2. Rewrite the buffered events' attachment paths to the relative `screenshotDir` form.
  3. Run `writeStaticArtifact` and `writeOfflineReport` over the rewritten events (internals unchanged).
- No cleanup: CI workspaces are ephemeral.

## Components Affected

- `src/reporter.ts` — CI detection + option; skip per-test copying; buffer per-test baseline input and native attachments; conditional `onEnd` copy/rewrite/artifact generation; conditional WebSocket connect.
- `src/reporter-utils.ts` — finalized naming integration; `__unnamed-screenshot-N` becomes fallback-only.
- `src/snapshot-path-resolver.ts` — expose auto-name reconstruction; use it for the `unnamed` target's `visualName`/`attachmentBaseName`/`artifactBaseName`.
- `src/reporter-artifact-ops.ts` — split copy from descriptor building; add CI-mode `onEnd` copy + event path-rewrite helper.
- `src/server/routes.ts` — new `/baseline/...` route; allowlisted native-artifact serving; live-mode image URL routing.
- `src/report-utils.ts` / `src/report-state.ts` — image URL construction aware of live vs. portable source.

## Error Handling

- Baseline resolution failure degrades to `declared-only` (no crash), as today.
- Allowlist violations on the native-artifact route return 404.
- Per-file copy failures in CI are logged and skipped (current behavior).
- Missing native files in live mode (e.g. after Playwright re-cleaned `outputDir`) return 404; the UI handles a missing image gracefully.

## Testing

Use `bun test`, test-first per project TDD.

- `isCI()` truthiness across `CI` values (`undefined`, `''`, `'false'`, `'0'`, `'true'`, `'1'`).
- Naming reconciliation: unnamed → real auto-name; duplicate-occurrence suffixes; named unchanged; fallback when `reporterTitlePath` absent. (`reporter-utils.test.ts`, `snapshot-path-resolver.test.ts`)
- No phantom `declared-only` entry when a real image exists for the same assertion. (`report-state.test.ts`, `report-utils` coverage)
- Live mode: `onTestEnd` emits native paths and performs no copies. (`reporter` coverage)
- CI mode: `onEnd` copies artifacts and rewrites event paths; static HTML + offline JSON reference the rewritten relative paths. (`offline.test.ts`)
- Server: `/baseline/...` resolves and streams; native-artifact route serves in-root files and returns 404 for out-of-root paths. (`server-routes.test.ts`)

## Migration / Compatibility

- Existing `screenshots/` directories from prior versions are not migrated or cleaned by this change; they can be removed manually.
- Reporter options gain `ci?: boolean`; all existing options are unchanged.
- The static artifact format is unchanged; only when it is generated changes (CI only).
