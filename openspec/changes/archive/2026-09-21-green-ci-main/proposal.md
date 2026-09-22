## Why

Every push to `main` since 2026-09-14 has failed CI. Three of the five jobs are red for two causes that are entirely test-infrastructure, plus one flaky assertion:

- **Lint & Type Check, Playwright Tests** — `error: ENOENT extracting tarball from @crvy/rprtr`. `examples/vitest-browser/bun.lock` pins the dependency to a macOS temp path, `@crvy/rprtr@/var/folders/.../T/opencode/crvy-rprtr-0.3.3.tgz`: a locally packed tarball was installed and the lockfile committed. That path does not exist on a Linux runner. The local tarball was not an accident of convenience: the example consumes `@crvy/rprtr/vitest`, and no published version exports it (`0.3.3` exports only `.`, `./server`, `./rendering` and `./types`), so the registry cannot satisfy this example at all.
- **Bun Tests** — `tests/vitest-browser-integration.test.ts` spawns a real browser-mode `vitest run`, but `test:bun` executes on a plain `ubuntu-latest` runner with no Playwright browsers installed. The run reports `0 passed, 0 failed, 0 skipped` and the assertion sees `["run-end"]` where it expects `["test-begin","test-end","run-end"]`. Compounding it, only `hero-section-chromium-darwin.png` is committed under the fixture's `__screenshots__`, while the test derives the path from `process.platform` — so the linux baseline is missing too. All three tests pass on macOS.
- **Bun Tests, intermittently** — `reporter browser pins > register payload carries the resolved environments` failed in 2 of 5 runs, each time at 3017–3019 ms against its own `waitFor(…, 3000)`. A loaded runner, not a defect.

Red-on-main has been the steady state for five runs, so CI no longer distinguishes a broken commit from the baseline.

## What Changes

- `examples/vitest-browser` consumes a tarball packed from source at a relative path, with the tarball and the example's lockfile untracked, and a check rejects a committed lockfile that resolves a dependency to an absolute local path.
- The browser-dependent integration tests stop running in a job that has no browser: they either move to the job running in the Playwright container, or gate on a browser being resolvable and say so when they skip. Whichever way, a run without a browser must not report a pass.
- The fixture's linux baseline is committed alongside the darwin one, so the platform-derived snapshot path resolves on both.
- The flaky `waitFor` budget is raised to a value appropriate for a shared runner.

## Capabilities

None — this change is repository tooling and test infrastructure. No consumer-visible behavior changes, so `.openspec.yaml` sets `skip_specs: true`.

## Impact

- CI: `.github/workflows/ci.yml` job composition for the browser-dependent tests.
- Tests: `tests/vitest-browser-integration.test.ts`, `tests/browser-pin-reporter.test.ts`, `tests/fixtures/vitest-browser/__screenshots__/`.
- Examples: `examples/vitest-browser/bun.lock`.
- No change to `src/`, the published package, or any documented behavior.

## Non-goals

- The Docker Smoke failure — a mandatory `vitest` peer crashing npm — which is the separate `optional-vitest-peer` change.
- Reworking how the vitest fixture captures or compares screenshots.
- Adding browser installation to every CI job; only the jobs that need one should have one.
- Making CI green by deleting or skipping coverage outright.
