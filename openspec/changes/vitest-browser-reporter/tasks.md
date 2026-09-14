# Tasks: vitest-browser-reporter

All `bun test` commands run inside `tests/` after `bun run build`.

## 1. Dependencies and build surface

- [ ] 1.1 Add `vitest` + `@vitest/browser-playwright` devDependencies, `vitest: ">=4 <5"` peerDependency, `"./vitest"` exports subpath, and `src/vitest.ts` build entry. Verify: `bun install && bun run build && node -e "import('@crvy/rprtr/vitest').then(()=>console.log('ok'))"`

## 2. Vitest helpers (test-first)

- [ ] 2.1 Write failing `tests/vitest-helpers.test.ts` covering: title-path extraction, browser-name resolution (project name → browser instance → fallback), image-name-from-path (browser+platform suffix, role suffix stripping), reference/attachment path builders for default and explicit dirs, status mapping, ANSI-stripping error parser extracting reference/actual/diff paths. Verify: `cd tests && bun test vitest-helpers.test.ts` (fails)
- [ ] 2.2 Implement `src/vitest-helpers.ts` (pure functions, `vitest/node` types only). Verify: `cd tests && bun test vitest-helpers.test.ts` (passes) && `bun run typecheck`

## 3. Register allowlist extension (test-first)

- [ ] 3.1 Write failing server test: register payload with `vitestAttachmentsDir`/`vitestReferenceDir` extends `artifactRoots`; `/file/` serves a file inside a registered vitest dir and rejects one outside all roots. Verify: `cd tests && bun test artifact-routes.test.ts` (new case fails)
- [ ] 3.2 Extend `RegisterDataSchema` (optional vitest dir fields) and `handleRegister` root pushing; add optional `provider` to test-begin/test data schemas. Verify: test from 3.1 passes && `cd tests && bun test report-state.test.ts` && `bun run typecheck`

## 4. Vitest reporter (test-first, mocked)

- [ ] 4.1 Write failing `tests/vitest-reporter.test.ts` with mocked Vitest `TestCase` (artifacts + error messages, per the spike's mock harness): failed comparison → renamed attachment entries with native absolute paths + expected/actual/diff images in the emitted event; first-run reference-only → baseline-only image; explicit dirs honored; run-end → offline JSON with schema-valid events. Verify: `cd tests && bun test vitest-reporter.test.ts` (fails)
- [ ] 4.2 Implement `src/vitest.ts` (`CrvyRprtrVitestReporter` on the shared transport): dev mode zero-copy renamed entries; CI-mode deferral + content-addressed copies via existing artifact ops; layered location resolution (D4); reserve `approvalTargets` as a documented, unimplemented payload field name (no field emitted yet). Verify: `cd tests && bun test vitest-reporter.test.ts` (passes) && `bun run typecheck`

## 5. Real-browser integration harness

- [ ] 5.1 Port the spike's fixture: `tests/fixtures/vitest-browser/` (vitest config with playwright provider + headless chromium, `toMatchScreenshot` test, committed reference PNG, `VITEST_HERO_COLOR` override for diff generation). Verify: `bunx vitest run --config tests/fixtures/vitest-browser/vitest.config.ts` exits nonzero with artifacts on disk
- [ ] 5.2 Write failing `tests/vitest-browser-integration.test.ts`: spawn the fixture run, assert schema-valid offline report with expected/actual/diff attachments, image URLs, and locations; assert exit code reflects the visual failure. Verify: fails, then passes after any harness fixes; `cd tests && bun test vitest-browser-integration.test.ts`

## 6. Docs and gate

- [ ] 6.1 README: Vitest Browser Mode setup section (install, provider, reporter options table including `referenceDir`/`attachmentsDir`), supported-layouts/limitations notes. Verify: manual review against spec scenarios
- [ ] 6.2 Full gate + Playwright regression + focused suites. Verify: `bun run check && bun run test:playwright && cd tests && bun test vitest-helpers.test.ts vitest-reporter.test.ts vitest-browser-integration.test.ts artifact-routes.test.ts`
