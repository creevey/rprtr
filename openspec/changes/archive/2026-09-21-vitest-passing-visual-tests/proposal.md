# Proposal: vitest-passing-visual-tests

## Why

After a passing Vitest run the rprtr UI shows no tests at all: tests seeded by
startup discovery disappear the moment the run finishes, leaving an empty
sidebar and an apparently empty report. The root cause is verified: Vitest
4.1.11 records `internal:toMatchScreenshot` artifacts only when the assertion
fails (`@vitest/browser` records nothing on pass), so the Vitest reporter
cannot identify passing visual tests. Their streamed results carry
`attachments: []` / `visualNames: []`, the server builds empty `images`, and the
sidebar's visibility rule (show a finished test only when it has screenshot
artifacts) hides every one of them. Users cannot verify the Vitest integration
works at all.

## What Changes

- The Vitest reporter learns each test's `toMatchScreenshot` declarations from
  test source code (the only remaining source of truth, since Vitest provides
  no pass-case data through its official Reporter API) and emits, for **passing**
  visual tests, the committed reference as an `expected` attachment plus
  `approvalTargets` — the same shape failing tests already produce.
- Passing visual tests therefore render in the sidebar with their baseline
  preview (`baseline-only`), stay approvable, and survive run-end culling,
  matching Playwright's passing-visual-test behavior.
- Non-visual passing Vitest tests remain hidden (the sidebar lists visual
  comparisons, not the whole suite) — unchanged by design.
- New integration coverage: a **passing** Vitest browser run (references match)
  is pinned so the pass case can never silently regress again (the existing
  fixture only covers the failing run).

## Capabilities

### New Capabilities

- (none)

### Modified Capabilities

- `vitest-reporter`: extends the "Screenshot artifact normalization" requirement
  to cover passing screenshot assertions: a passing `toMatchScreenshot` whose
  reference exists SHALL surface as a baseline-only image (expected preview +
  approval metadata) instead of an empty artifact set.

## Impact

- `src/vitest.ts` / new declaration-extraction module: per-test
  `toMatchScreenshot(name)` extraction from test source, Vitest name
  sanitization replicated, occurrence counting for repeated names.
- `src/vitest-helpers.ts` / `src/vitest-artifacts.ts`: reference-path reuse for
  the synthetic expected attachment and approval targets.
- `tests/fixtures/vitest-browser/` + `tests/vitest-browser-integration.test.ts`:
  passing-run fixture and assertions (schema-valid offline report with
  baseline-only images).
- No server, client/UI, schema, or public-API changes required — validated
  against the existing `applyTestEndEvent` pipeline.
- Docs: `README.md` Vitest Browser Mode section, `examples/vitest-browser/README.md`.

## Non-goals

- Upstream Vitest changes (recording artifacts on pass) — tracked separately;
  extraction is version-pinned behind one module like D4 parsing.
- Showing non-visual passing Vitest tests in the sidebar.
- `vitest list`-based discovery accuracy, watch-mode reconnect behavior,
  and UI run controls — unchanged.
- Custom Vitest path resolvers (already rejected by the existing spec).
