# Design: vitest-passing-visual-tests

## Context

See proposal.md — Why. Investigation evidence (reproduced live, September 2026):

- Server state is correct after a passing run; the Svelte client hides every
  finished test whose `results[0].images` is empty
  (`src/client/helpers/status.ts` `isTreeVisible`).
- The Vitest reporter's only pass/fail-independent inputs are
  `testCase.artifacts()` (`internal:toMatchScreenshot`) and the failure error
  message. Vitest 4.1.11 records that artifact **only when the assertion
  fails** — verified in `@vitest/browser`'s bundled matcher source
  (`expect-element.js`: `if (u.pass === false) { … recordArtifact … }`) and by a
  runtime probe (`artifactCount: 0` for passing visual tests). The official
  Reporter API offers no steps, no assertion log, and no snapshot-state hook for
  this matcher (it does not use Vitest's snapshot system).
- Playwright parity: the Playwright reporter emits `visualDeclarations` parsed
  from step titles for every test; the server resolves baselines and passing
  visual tests stay visible (`baseline-only`). The Vitest reporter never got an
  equivalent — the vitest-browser-reporter design (D4) anticipated "artifact
  presence on pass" as a risk but the integration fixture pins only the failing
  run.
- Fix shape validated against the real pipeline: a passing test-end carrying a
  reference-path `-expected.png` attachment + `approvalTargets` flows through
  `applyTestEndEvent` into a visible, previewable (`/file/` URL), approvable
  (`approveFromPath`/`approveToPath`) `baseline-only` image. No server or client
  changes needed.

## Goals / Non-Goals

**Goals**

- Passing Vitest visual tests visible + approvable in dev, CI/offline, and
  static-HTML surfaces, with the same payload shape failing tests use.
- Declaration extraction isolated in one module so a Vitest bump touches one
  file (mirrors D4's parsing-module philosophy).
- Integration coverage of the passing run (the gap that let this ship).

**Non-Goals**

- Upstream Vitest changes; UI visibility-rule changes; non-visual passing tests
  in the sidebar; watch-mode reconnects (see proposal Non-goals).

## Decisions

### D1: Source-level declaration extraction, not artifact/runtime hooks

Extract `toMatchScreenshot(<name>)` call sites per test from the test module's
source (`testCase.module.moduleId`), attributing them to tests by title, and
replicate Vitest's naming rules.

- Alternative: upstream Vitest change to record artifacts on pass — correct
  long-term, but out of repo control and blocks users today.
- Alternative: skip extraction and relax the UI visibility rule for
  `provider: 'vitest'` — hides the symptom, still leaves passing visual tests
  without previews or approval metadata, and pollutes the "visual comparisons"
  sidebar with non-visual tests.
- Alternative: derive names by listing the reference directory — file-level
  granularity cannot attribute references to tests within one file.

### D2: Replicate Vitest's exact naming contract in one module

Vitest computes the reference path as
`<root>/<testFileDir>/<referenceDir>/<testFileName>/<sanitized(arg)>-<browser>-<platform>.png`
where `sanitized` splits on `/`, sanitizes each segment (whitespace → `-`,
strip non-`[\w-]`, collapse repeats), and repeated names within a test get an
occurrence suffix (`-1`, `-2`, … per Vitest's per-test counter keyed by
`repeatCount + testPath + testName`). The extraction module reproduces this
(sanitization already exists in spirit in `vitest-helpers.ts`
`getImageNameFromPath`; the writer-side mirror is new) and reuses the existing
`buildReferencePath` for path construction. Extraction of the call argument
supports string literals only; template literals/variables degrade to no
declaration (logged) rather than a guessed name.

### D3: Emit the reference as an `expected` attachment + `approvalTargets` for passing visual tests

For each extracted declaration of a passing test where
`existsSync(referencePath)`: emit
`{ name: '<image>-expected.png', path: referencePath, contentType: 'image/png' }`
plus `approvalTargets[image] = referencePath`. This is byte-identical to what
failures already emit for the reference role, so dev (`/file/` serving),
CI (content-addressed copy via the existing `saveAttachments` deferral), static
HTML, offline JSON, and approval metadata all work through existing code paths —
verified against `applyTestEndEvent`.

- Missing reference on a passing assertion: emit nothing for that image and log
  (the spec's "honest failure" scenario) — do not invent files.
- `visualNames`/`visualDeclarations` are also emitted so report-state
  classifies the image `baseline-only` (not `declared-only`).

### D4: Test attribution by source scan, best-effort

The extractor maps test titles → call sites by scanning `test(…)`/`it(…)` blocks
(regex-based like the Playwright step-title extraction, not a full AST) within
the module source. Tests whose titles cannot be matched keep failure-only
behavior. Known trade-off: dynamically generated test titles break attribution;
acceptable because Vitest's own reference files also derive from the literal
name argument, so named-literal call sites are the dominant, reliable case.

### D5: Pin the passing run in the integration suite

Extend `tests/fixtures/vitest-browser/` with a passing-run path (references
match; no `VITEST_HERO_COLOR` override) and assert: exit 0, schema-valid offline
report, `baseline-only` image with approval targets, and a UI-visibility
invariant (images non-empty). This is the tripwire the original change lacked
(design risk "artifact presence on pass" — surfaced as a test, not a silent UI
gap).

## Risks / Trade-offs

- [Vitest naming/sanitization drift breaks extraction] → single extraction
  module; D5 integration test pins on-disk reference names; degradation is
  graceful (failure-only behavior, logged).
- [Regex source scan misattributes call sites in exotic files] → extraction
  only ADDS passing-visual data; worst case equals today's behavior. Literal
  string arguments required for a name.
- [Reference deleted between run and report] → spec's missing-reference
  scenario: no synthetic image, logged gap.
- [Offline/CI path divergence] → the deferral flush already rewrites
  attachment paths via `saveAttachments`; the new expected attachment flows
  through the same `pendingArtifacts` mechanism — covered by the integration
  test run in CI mode.

## Migration Plan

Additive reporter behavior; no schema or API changes; old reports and consumers
unaffected. Rollback = revert. Vitest version pin (`>=4 <5`) unchanged.

## Open Questions

- None blocking; occurrence-counter edge cases across `retry`/`repeats` are
  pinned by D5 tests during implementation.
