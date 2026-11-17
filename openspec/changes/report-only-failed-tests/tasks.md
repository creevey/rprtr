# Tasks

- [x] 1.1 Add `reportOnlyFailedTests` to the shared transport options and `CrvyRprtrOptions`; `ReporterTransport.keepsResult` drops non-failed results and their pending `test-begin` in CI only.
- [x] 1.2 Skip artifact collection and `test-end` for dropped results in the Playwright and Vitest reporters.
- [x] 1.3 Cover default, filtering, retries and live-mode ignore in `tests/report-only-failed-tests.test.ts`, and the Vitest path in `tests/vitest-reporter.test.ts`.
- [x] 1.4 Document the option in both README option tables.
