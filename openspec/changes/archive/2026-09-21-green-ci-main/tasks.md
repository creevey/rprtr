## 1. Example lockfile

- [x] 1.1 Point `examples/vitest-browser` at a tarball packed from source at `file:./crvy-rprtr.tgz`, add a `pack` script, and gitignore both the tarball and the example's `bun.lock` — no published version exports `./vitest`, so the registry cannot satisfy this example. CI packs before installing. Verify: `cd examples/vitest-browser && bun run pack && bun install`, then `bun run lint` and `bun run lockfiles`
- [x] 1.2 Add a check that fails when any committed lockfile resolves a dependency to an absolute filesystem path, covering the root and `examples/*`, and wire it into `bun run check`. Confirm it fails against the pre-1.1 lockfile and passes after. Verify: `bun run check`

## 2. Fail loudly on a vitest run that executed nothing

- [x] 2.1 Write a failing test that the vitest integration helper rejects a child run reporting zero executed tests, rather than proceeding to assert on the event list. Verify: `cd tests && bun test vitest-browser-integration.test.ts` (expect failure)
- [x] 2.2 Add the non-empty-run assertion to `spawnFixtureVitestRun` / `spawnPassingFixtureVitestRun` in `tests/vitest-browser-integration.test.ts`, so a browserless environment produces a named failure instead of a confusing event-list mismatch. Verify: `cd tests && bun test vitest-browser-integration.test.ts`

## 3. Run browser-dependent tests where a browser exists

- [x] 3.1 Move the browser-dependent test files into `tests/browser/` (two files, not three — the proposal counted the three tests inside `vitest-browser-integration.test.ts`) and split `test:bun` into a runner-independent glob plus a separate browser-tests script, leaving `bun run test` covering both. Verify: `bun run test:bun` passes on a machine with no browsers; the browser script fails there
- [x] 3.2 Move the browser-tests script into the `Playwright Tests` job in `.github/workflows/ci.yml` and confirm the `Bun Tests` job no longer globs those files. Verify: `bun run test:bun` locally, then a CI run on the branch
- [x] 3.3 Generate and commit `tests/fixtures/vitest-browser/__screenshots__/vitest.integration.browser.test.ts/hero-section-chromium-linux.png` from `mcr.microsoft.com/playwright:v1.59.0-noble`, reviewing the image in the diff. Verify: the browser-tests script passes inside that container

## 4. Flaky pin assertion

- [x] 4.1 Raise the `waitFor` budget in `tests/browser-pin-reporter.test.ts` from 3 s to 10 s, keeping the polling interval. Verify: `cd tests && bun test browser-pin-reporter.test.ts`

## 5. Confirm main is green

- [x] 5.1 Full gate: `bun run check` and `bun run test:playwright`
- [x] 5.2 Confirm on CI that `Lint & Type Check`, `Bun Tests`, `Playwright Tests` and `Build` all pass on the branch, and note that `Docker Smoke` stays red until the `optional-vitest-peer` change lands. Verify: `gh run list --branch <branch> --limit 1`
