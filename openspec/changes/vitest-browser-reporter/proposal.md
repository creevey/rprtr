# Proposal: vitest-browser-reporter

## Why

`@crvy/rprtr` only reports Playwright runs. Vitest 4's browser mode ships a first-class `toMatchScreenshot()` visual-testing assertion, but its diffs are invisible to the rprtr UI: teams doing component testing get vitest's own report and no compare/approve workflow. A validated spike (PR #2, Apr 2026) proved the integration end-to-end — real chromium browser runs, artifact capture, offline reports. This change lands that support on the current server-side-serving architecture.

## What Changes

- New reporter entry `src/vitest.ts`, published as the `./vitest` export subpath: `CrvyRprtrVitestReporter` implementing vitest's `Reporter`, built on the shared transport from `extract-reporter-transport`.
- Reporter maps Vitest browser-mode screenshot artifacts (`reference`/`actual`/`diff` attachments of `toMatchScreenshot` failures, plus first-run reference-only artifacts) to rprtr test events:
  - dev mode: zero-copy — attachment entries renamed to rprtr's `<image>-(actual|expected|diff)` convention, pointing at vitest's native absolute paths; server serves them via `/file/`.
  - CI mode: content-addressed copies into `screenshotDir` (reusing `saveAttachments`/baseline-copy ops) so static `crvy-rprtr.html` and offline JSON stay portable.
- Register payload extended with vitest artifact directories so the server allowlists them in `artifactRoots`.
- First-run baselines surface as `baseline-only` images (expect-only) and are viewable; approving them belongs to the follow-up approval change (`approvalTargets` seam is reserved here, unimplemented).
- New dev dependencies `vitest` + `@vitest/browser-playwright`; peer dependency `vitest >=4 <5`.

## Capabilities

### New Capabilities

- `vitest-reporter`: reporting Vitest browser-mode `toMatchScreenshot` results to the rprtr server and artifacts — event stream (test-begin/end, run-end), image normalization from vitest artifacts, dev zero-copy + CI portable modes, offline/static parity, and register-time directory allowlisting. No existing capability covers a non-Playwright provider; `openspec/specs/` is empty today, so this creates the first provider-reporter spec. Playwright reporting is unchanged (its behavior remains defined by code until its own spec lands).

### Modified Capabilities

_None._

## Impact

- **Code**: new `src/vitest.ts` + `src/vitest-helpers.ts` (path/layout helpers, ANSI-stripped error parsing, status mapping); `src/schemas.ts` (`RegisterDataSchema` vitest dir fields, optional `provider` on test-begin/test data); `src/server/handlers.ts` (push vitest roots into `artifactRoots`); `build.ts` (new entry); `package.json` (exports map, peer/dev deps); `tests/` (unit + real-browser integration harness under `tests/fixtures/vitest-browser/`).
- **Public surface**: new `./vitest` export; peer dep on `vitest` added; existing exports untouched.
- **Docs**: `README.md` gains a Vitest Browser Mode setup section (mirrors the spike's).
- **Verification**: `bun test vitest-helpers.test.ts` / `vitest-reporter.test.ts` / `vitest-browser-integration.test.ts` (spawns real chromium via `test:vitest-reporter`-style fixture run), full `bun run check`, `bun run test:playwright` (Playwright regression gate).

## Non-goals

- No approval support for vitest (`approvalTargets` channel reserved by name only; follow-up change).
- No UI-triggered vitest runs — `run-launcher` stays Playwright-only; users run vitest themselves.
- No docker/containerized vitest runs.
- No declaration synthesis for `visualDeclarations` (vitest artifacts cannot enumerate artifact-less assertions; UI shows only reported images).
- No support for custom vitest `resolveScreenshotPath`/`resolveDiffPath` resolvers — default layouts plus explicit `referenceDir`/`attachmentsDir` options only.
