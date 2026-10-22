# Tasks

## 1. Playwright offline report metadata tests

- [x] 1.1 Add `tests/offline-worker-metadata.test.ts` with failing cases: `onBegin` with `config.workers: 2` followed by test results carrying `workerIndex` 0 and 1 produces one report with `workers: 2` and matching per-event indexes; `workers: 1` keeps every test event at 0; an interrupted result with `workerIndex: -1` normalizes to 0; the default `offlineReportPath` is `./crvy-rprtr-0.json` even when `TEST_WORKER_INDEX` is set; an explicit path containing `{worker}` is written literally. Verify: `bun run build && cd tests && bun test offline-worker-metadata.test.ts` (new cases fail).
- [x] 1.2 Update `tests/offline.test.ts` so its report-path fixture expects `./crvy-rprtr-0.json` and its `workers` assertion reflects the constructor fallback (or drives `onBegin` with a worker count). Verify: `cd tests && bun test offline.test.ts` (fails before implementation).
- [x] 1.3 Update the `tests/reporter-output.test.ts` harness to pass a `workerIndex`-bearing result to `onTestBegin` and keep the persisted-event comparison meaningful once attribution is implemented. Verify: `cd tests && bun test reporter-output.test.ts`.

## 2. Playwright implementation

- [x] 2.1 Extend `RunEvent` and `ReporterTransport.send(message, workerIndex?)` so the index travels with each event, and stop stamping one index across every event in `writeOfflineReport`. Verify: the per-event index cases from task 1.1 pass with `cd tests && bun test offline-worker-metadata.test.ts`.
- [x] 2.2 Add `setWorkers(count)` to `ReporterTransport`, call it from `CrvyRprtr.onBegin` with `config.workers`, pass the resolved count to `writeOfflineReport`, and normalize negative/non-finite result indexes to 0. Verify: `cd tests && bun test offline-worker-metadata.test.ts reporter-output.test.ts offline.test.ts`.
- [x] 2.3 Make the default path the constant `./crvy-rprtr-0.json` and keep `workerIndex`/`TEST_WORKER_INDEX` as compatibility-only fallbacks rather than file-naming input. Verify: the default-path case from task 1.1 and `cd tests && bun test offline.test.ts offline-artifact.test.ts`.

## 3. Vitest worker capacity

- [x] 3.1 Extend `tests/vitest-reporter.test.ts` with failing cases: a CI offline report records `workers` from `vitest.config.maxWorkers` (mock it as 4) while all Vitest event indexes remain 0; a mock without `maxWorkers` falls back to `workers: 1`. Verify: `cd tests && bun test vitest-reporter.test.ts` (new cases fail).
- [x] 3.2 Call `this.transport.setWorkers(vitest.config.maxWorkers)` from `CrvyRprtrVitestReporter.onInit`, with the shared clamp/fallback, and leave event attribution at 0 with a code comment naming the public-API limitation. Verify: `cd tests && bun test vitest-reporter.test.ts`.

## 4. Documentation

- [x] 4.1 Update `README.md`: both `offlineReportPath` tables show `./crvy-rprtr-0.json`, the Offline Mode section describes one report per run, and the server-loading sentence matches the names discovery accepts. Verify: `rg -n '\{worker\}|per-worker|each worker writes' README.md` returns nothing.
- [x] 4.2 Update `docs/offline-mode.md`: step 4 names `crvy-rprtr-0.json`, the artifact list matches the actual name, the limitations section drops the per-worker claim, and the `TEST_WORKER_INDEX` row no longer presents file naming. Verify: `rg -n '\{worker\}|per-worker|each worker writes' docs/offline-mode.md` returns nothing and `bun run format:check` passes.

## 5. Full gate

- [x] 5.1 Run `bun run check` and `bun run test:playwright`; both exit 0. Browser behavior is unchanged, but the offline artifact E2E exercises the reporter path this change touches.
