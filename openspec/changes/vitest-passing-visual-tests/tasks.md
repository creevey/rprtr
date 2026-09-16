# Tasks: vitest-passing-visual-tests

All `bun test` commands run inside `tests/` after `bun run build`.

## 1. Declaration extraction module (test-first)

- [x] 1.1 Write failing `tests/vitest-declarations.test.ts`: extract `toMatchScreenshot('name')` per test title from source samples — named calls, repeated names (occurrence suffix `-1`, `-2` per Vitest's counter), path-like names (`/` segment split + per-segment sanitization), non-literal arguments degrade to no declaration, unreadable file degrades to empty. Verify: `cd tests && bun test vitest-declarations.test.ts` (new cases fail)
- [x] 1.2 Implement `src/vitest-declarations.ts` (sanitization mirror + title attribution + occurrence counting) and wire reference-path construction through the existing `buildReferencePath`. Verify: tests from 1.1 pass && `bun run typecheck`

## 2. Reporter emits passing-visual data (test-first)

- [x] 2.1 Write failing `tests/vitest-reporter.test.ts` case: a passed `TestCase` with extracted declarations produces `attachments: ['<image>-expected.png' with reference path]`, `visualNames`, and `approvalTargets[image] = referencePath`; missing reference file on disk emits no expected attachment and logs; non-visual passing test emits neither. Verify: `cd tests && bun test vitest-reporter.test.ts` (new cases fail)
- [x] 2.2 Implement in `src/vitest.ts` `onTestCaseResult`: merge extracted-declaration entries (passing tests) with artifact/error-derived entries (failures), preserving the existing failing-path payload byte-for-byte. Verify: tests from 2.1 pass && existing `vitest-reporter.test.ts`, `vitest-helpers.test.ts`, `vitest-browser-integration.test.ts` still green

## 3. Passing-run integration coverage

- [x] 3.1 Extend `tests/fixtures/vitest-browser/` with a passing-run scenario (matching references, no color override) and extend `tests/vitest-browser-integration.test.ts`: exit 0, schema-valid offline report, baseline-only image with expected path + approval targets, attachment paths portable in CI mode. Verify: `cd tests && bun test vitest-browser-integration.test.ts`
- [x] 3.2 Live UI verification: run the server + example Vitest project (passing run), confirm tests remain visible with baseline previews after run-end and approve round-trips (temp fixture copy, never the committed PNG). Verify: manual walkthrough matching `examples/vitest-browser/README.md` quickstart

## 4. Docs and gate

- [ ] 4.1 Update `README.md` Vitest Browser Mode section and `examples/vitest-browser/README.md`: passing visual tests appear with baseline preview and stay approvable; first-run UX unchanged. Verify: manual review against spec scenarios
- [x] 4.2 Full gate + browser regression. Verify: `bun run check && bun run test:playwright && cd tests && bun test`
