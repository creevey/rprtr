# Proposal

## Why

Offline JSON reports describe a run with a single writer — the reporter lives in the runner's main process — yet their metadata still pretends each worker writes its own file. Every event carries `workerIndex: 0` and the report records `workers: 1` regardless of configured parallelism, because both values come from `TEST_WORKER_INDEX` in the main process instead of the run's real worker information. The README and `docs/offline-mode.md` reinforce the fiction by documenting a `{worker}` placeholder that the package never substitutes and by describing per-worker files.

## What Changes

- Playwright `test-begin`/`test-end` events record the executing worker from Playwright's `result.workerIndex` instead of the transport-wide env value.
- The report-level `workers` field records the run's configured worker count: Playwright `config.workers`, Vitest's resolved `maxWorkers`.
- Vitest events keep `workerIndex: 0` because Vitest's public reporter API exposes no executing worker id; the limitation is documented rather than fabricated.
- The documented default for `offlineReportPath` becomes the actual single-file default `./crvy-rprtr-0.json`. The legacy `-0` suffix is retained so existing artifact globs and uploads keep working; no `{worker}` substitution is added.
- README and `docs/offline-mode.md` stop describing per-worker reports and stop presenting `TEST_WORKER_INDEX` as file-naming input.

## Capabilities

### New Capabilities

- `offline-report`: the contract for the offline JSON report file — one report per run, its default path and discovery, its run-level worker count, and its per-event worker attribution across Playwright and Vitest.

### Modified Capabilities

- `run-lifecycle`: the artifact-replay requirement stops describing offline reports as per-worker; replay semantics themselves are unchanged.
- `vitest-reporter`: the CI-artifact requirement stops claiming per-worker Vitest reports and states where the run-level worker count comes from and why per-event worker attribution is unavailable.

## Non-goals

- Renaming the default file to `crvy-rprtr.json`; the existing `-0` name is kept to avoid breaking artifact upload patterns.
- Implementing `{worker}` substitution or restoring genuinely per-worker offline files; one report per run is the intended model.
- Changing the offline report schema version or its replay semantics.
- Inferring Vitest's per-test worker assignment, which the public reporter API does not expose.
- Any change to live streaming, report state, or the static HTML artifact.

## Impact

- Code: `src/transport.ts`, `src/reporter.ts`, `src/vitest.ts`, `src/reporter-artifact-ops.ts`, and the shared offline report types.
- Tests: offline reporter/artifact suites plus the Vitest reporter integration and the multi-worker E2E coverage.
- Docs: `README.md` and `docs/offline-mode.md`.
- Published surface: no new exports, options, or dependencies; existing `offlineReportPath` overrides keep being written literally.
