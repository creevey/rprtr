# Tasks

## 1. Shared discovered-test machinery

- [x] 1.1 Add `tests/discovered-tests.test.ts` pinning the runner-neutral contract — `DISCOVERED_ID_PREFIX`, `discoveredTestIdentity`, `mergeDiscoveredTests` over synthesized `TestData[]` (fills gaps only, never downgrades loaded results), and `withoutDiscoveredTests` — and watch it fail against the missing module (`cd tests && bun test discovered-tests.test.ts`).
- [x] 1.2 Extract the neutral pieces from `src/server/vitest-discovery.ts` and `src/server/vitest-seeding.ts` into `src/server/discovered-tests.ts` (prefix, identity, generalized merge, persistence filter, startup dispatch) and update importers (`src/report-state.ts`, `src/server/app.ts`, Vitest tests) with no behavior change (`cd tests && bun test discovered-tests.test.ts vitest-discovery.test.ts vitest-discovery-app.test.ts`; `bun run typecheck`).

## 2. Playwright list parsing and synthesis

- [x] 2.1 Add failing unit tests in `tests/playwright-discovery.test.ts` for `parsePlaywrightListReport` / `synthesizePlaywrightDiscoveredTests` over a JSON list report: nested describe title paths, one entry per project test, file tokens relative to the config directory, absolute locations resolved from `rootDir`-relative ones, browser label from the project name, `pending` status, and `discovered:` ids (`cd tests && bun test playwright-discovery.test.ts`).
- [x] 2.2 Implement `parsePlaywrightListReport` and `synthesizePlaywrightDiscoveredTests` in `src/server/playwright-discovery.ts` until 2.1 passes (`cd tests && bun test playwright-discovery.test.ts`; `bun run typecheck`).
- [x] 2.3 Add failing tests for `runPlaywrightList` with an injected spawn: the command is `playwright test --list --reporter=json --config <configFile>` resolved through `resolveLocalCommand`, stdin is closed, and spawn errors, malformed output, and timeouts yield an empty list (`cd tests && bun test playwright-discovery.test.ts`).
- [x] 2.4 Extend `readPlaywrightListReport` in `src/project-pins.ts` with the optional config path and spawn seam, implement `runPlaywrightList` on top of it, and verify the new tests plus the pins regressions pass (`cd tests && bun test playwright-discovery.test.ts cli-browsers.test.ts docker-preflight.test.ts browser-pin-reporter.test.ts`; `bun run typecheck`).

## 3. Startup dispatch and integration

- [ ] 3.1 Add failing startup tests in `tests/playwright-discovery-app.test.ts` mirroring the Vitest app tests: a temp project with `playwright.config.ts` and a spec file seeds run controls and a `pending` tree with no prior run; a failing listing keeps the controls, leaves the tree empty, and logs once; a streamed test-begin replaces its discovered placeholder and `report.json` keeps no discovered entries (`cd tests && bun test playwright-discovery-app.test.ts`).
- [ ] 3.2 Generalize the startup dispatch in `src/server/app.ts` (dispatch by `runContext.runner`, Playwright when absent) through `src/server/discovered-tests.ts` so the Playwright lister runs for a seeded Playwright context, then make 3.1 pass (`cd tests && bun test playwright-discovery-app.test.ts vitest-discovery-app.test.ts`; `bun run typecheck`).

## 4. Docs and full gate

- [ ] 4.1 Update README.md — the `--config` row, the run-buttons bullets ("Vitest discovery" becomes pre-run discovery for both runners), and the Vitest section's first-run sentence — and verify `bun run format:check` (no `docs/*.md` behavior pages change).
- [ ] 4.2 Full gate: `bun run check` (lint, typecheck, format:check, knip, test:bun, duplicates, publint); browser behavior is unchanged, so `bun run test:playwright` is not required. Confirm every task above is checked and `openspec validate playwright-pre-run-listing --strict` passes.
