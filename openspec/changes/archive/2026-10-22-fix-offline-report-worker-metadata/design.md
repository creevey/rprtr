# Design

## Context

See `proposal.md` — Why. The pieces that shape the approach:

- `src/transport.ts` owns `workerIndex` (`options.workerIndex ?? TEST_WORKER_INDEX ?? 0`), computes the default path from it, records only `{ type, data }` per event, and calls `writeOfflineReport(runEvents, offlineReportPath, workerIndex)` at finish.
- `src/reporter-artifact-ops.ts` stamps both `workers: workerIndex + 1` and every event's `workerIndex` from that single constructor-time value.
- Playwright's reporter runs in the runner's main process. `onBegin(config)` receives the resolved `FullConfig.workers`; `onTestBegin(test, result)` and `onTestEnd(test, result)` receive a `TestResult` whose `workerIndex` is the executing worker. `onTestBegin` currently ignores its `result` argument.
- The Vitest reporter runs in the main Vitest process. `onInit(vitest)` exposes `vitest.config.maxWorkers`, but the public reporter surface (`TestCase.result()`, `diagnostic()`, and task-update packs) exposes no executing worker id. Vitest only knows the worker id inside worker/context internals.
- `findOfflineReportPaths` already accepts both `crvy-rprtr.json` and `crvy-rprtr-<digits>.json`, so the default name can stay `crvy-rprtr-0.json` without touching discovery.
- The misleading claims live in `README.md` (two option tables and the offline section) and `docs/offline-mode.md` (step 4, artifact glob, limitations, and the `TEST_WORKER_INDEX` row).

## Goals / Non-Goals

**Goals:**

- Attribute Playwright events to the worker that actually ran them.
- Record a run-level `workers` value that reflects configured parallelism for both runners.
- Keep one report per run and keep every explicit `offlineReportPath` literal.
- Make the documented default match the written default without renaming the file.

**Non-Goals:**

- Restoring genuinely per-worker offline files or implementing `{worker}` substitution.
- A schema version bump or any change to offline replay.
- Inferring Vitest's per-test worker assignment.
- Renaming the default to `crvy-rprtr.json`; the `-0` name is retained for artifact-glob compatibility.

## Decisions

### D1 — Worker index travels with each event, not with the report

`RunEvent` gains a required `workerIndex`, and `ReporterTransport.send(message, workerIndex = this.workerIndex)` records it. Playwright's `onTestBegin` and `onTestEnd` pass `result.workerIndex`; `run-end`, Vitest events, and any caller that omits the argument keep the transport fallback (0 in the main process). `writeOfflineReport` stops stamping a single index across every event and preserves each event's own value.

Playwright documents `workerIndex: -1` for the interrupted result of a run that never started a worker, so a small normalizer maps any non-negative finite index through unchanged and maps negative/non-finite values to `0`. This keeps the written metadata inside the schema's expected shape without inventing a worker.

Alternatives considered: keeping a report-level index (cannot describe a multi-worker run); one file per worker (there is one writer); a side map from event to worker (more state for the same result).

### D2 — Run-level `workers` comes from provider configuration

`ReporterTransport` gains `setWorkers(count)`. The Playwright reporter calls it from `onBegin` with `config.workers`; the Vitest reporter calls it from `onInit` with `vitest.config.maxWorkers`. The value is clamped to a positive integer, and the report falls back to `1` when neither provider supplies a count. `finish()` passes that value to `writeOfflineReport`.

Alternatives considered: deriving the count from the maximum observed `result.workerIndex` (under-reports when a configured worker did no work, and unavailable for Vitest); keeping `workerIndex + 1` (always 1 in real runs).

### D3 — Keep `./crvy-rprtr-0.json` as the default and stop deriving it from the legacy index

The default path becomes a constant `./crvy-rprtr-0.json`; it is no longer built from `workerIndex` or `TEST_WORKER_INDEX`. Explicit `offlineReportPath` values continue to be written literally. The `workerIndex` option/env survives only as the compatibility fallback for per-event attribution, not as file-naming input or the run-level count. This preserves the existing artifact glob `crvy-rprtr-*.json` and every CI upload that names `crvy-rprtr-0.json`.

Alternatives considered: renaming to `crvy-rprtr.json` (cleaner, but breaks users and docs that upload `crvy-rprtr-*.json`, which does not match the new name); keeping `crvy-rprtr-${workerIndex}.json` (continues to imply a per-worker model that does not exist).

### D4 — Vitest keeps `workerIndex: 0` and reports its resolved capacity

Vitest's public reporter API exposes no executing worker id, so fabricating one would be worse than the current constant. The report-level `workers` still becomes accurate from `vitest.config.maxWorkers`, and the limitation is recorded in the design and in the code comment next to the Vitest event path. Making the field optional was rejected: it changes the schema for no replay benefit, since no consumer reads per-event `workerIndex`.

## Risks / Trade-offs

- **Playwright interrupted results carry `workerIndex: -1`** → normalize negative and non-finite values to `0`; the report stays schema-valid and does not pretend a worker ran.
- **`config.workers` is the configured count, not the number of workers that actually did work** → documented as the run's configured worker capacity; it is the only provider-wide value available before results stream.
- **`TEST_WORKER_INDEX` no longer changes the default file name** → keep the env/option as a metadata fallback, remove its file-naming claim from the docs, and call the change out in the changelog.
- **Multiple CI shards or processes still share the default file name** → unchanged from today; the package has no sharding model, and explicit `offlineReportPath` remains available for separate artifact directories.
- **Vitest `maxWorkers` may overstate the workers that executed tests** → the spec defines `workers` as configured capacity; per-event attribution remains explicitly unavailable.

## Migration Plan

Additive at the artifact boundary: the schema version and replay rules do not change, existing offline reports keep loading, and the default file name stays `crvy-rprtr-0.json`. Explicit `offlineReportPath` overrides are untouched. The only behavior change for a consumer is that `TEST_WORKER_INDEX` no longer renames the default file; document it as a legacy metadata fallback. Rollback is a code revert; no data migration is needed.

## Published Surface

No new exports, bin entries, peer dependencies, or dist layout changes. `workerIndex` remains accepted by the Vitest reporter options type for source compatibility but no longer names the file. `setWorkers` stays internal to `ReporterTransport`, which is not part of the package's exports map.
