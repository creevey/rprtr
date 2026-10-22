# offline-report Specification

## Purpose

Defines the offline JSON report written when a run has no live server: one report per run, the path the reporter actually writes, and the worker metadata consumers can rely on.

## Requirements

### Requirement: One offline report per run

A run SHALL write at most one offline JSON report file, produced by the reporter in the runner's main process and containing every `test-begin`, `test-end`, and `run-end` event for the run. When `offlineReportPath` is configured, the reporter SHALL write that path literally, without expanding `{worker}` or any other token. Otherwise it SHALL write `./crvy-rprtr-0.json`. The reporter SHALL NOT create one file per Playwright or Vitest worker.

#### Scenario: Parallel Playwright run writes one report

- **WHEN** an offline or CI Playwright run configured with `workers: 2` executes tests in both workers and no `offlineReportPath` is set
- **THEN** exactly one `./crvy-rprtr-0.json` is written
- **AND** it contains the `test-begin` and `test-end` events from both workers

#### Scenario: Explicit path is written literally

- **WHEN** a run sets `offlineReportPath: "./artifacts/crvy-rprtr.json"`
- **THEN** exactly that path is written
- **AND** no `{worker}` or other placeholder is substituted into the file name

#### Scenario: Path containing a placeholder is not expanded

- **WHEN** a run sets `offlineReportPath` containing the literal text `{worker}`
- **THEN** the file is written with that literal text in its name and no worker index replaces it

#### Scenario: Vitest run writes one report

- **WHEN** an offline or CI Vitest Browser Mode run completes with tests spread across multiple workers
- **THEN** one offline JSON report is written for the run containing all of its events

### Requirement: Offline report worker metadata

The report-level `workers` field SHALL record the run's configured worker count: Playwright's resolved `config.workers` and Vitest's resolved `maxWorkers`. Each Playwright `test-begin` and `test-end` event SHALL record the executing worker's index from Playwright's test result, within `0` to `workers - 1`. Vitest test events SHALL record `workerIndex: 0` because Vitest's public reporter API exposes no executing worker id; the run-level `workers` field SHALL still record the resolved count. When a runner cannot resolve a worker count, the report SHALL record `workers: 1`. Worker metadata SHALL NOT change the event payloads or the replayed report state.

#### Scenario: Playwright events name the workers that executed them

- **WHEN** a Playwright run configured with `workers: 2` executes tests on both workers
- **THEN** the report records `workers: 2`
- **AND** each `test-begin` and `test-end` event records that test result's `workerIndex` (`0` or `1`)

#### Scenario: Playwright single-worker run

- **WHEN** a Playwright run configured with `workers: 1` completes
- **THEN** the report records `workers: 1`
- **AND** every test event records `workerIndex: 0`

#### Scenario: Vitest reports its resolved worker capacity

- **WHEN** a Vitest run resolves `maxWorkers` to `4`
- **THEN** the offline report records `workers: 4`
- **AND** Vitest test events record `workerIndex: 0`

#### Scenario: Worker metadata does not alter replay

- **WHEN** a report carrying worker metadata is replayed by the CLI or server artifact-dir mode
- **THEN** the resulting tests, statuses, images, and approvals are identical to the same report with the metadata ignored

#### Scenario: Unknown worker count falls back to one

- **WHEN** a runner cannot resolve a configured worker count
- **THEN** the report records `workers: 1`

### Requirement: Published offline report path is the written path

The package documentation SHALL state the actual default offline report path `./crvy-rprtr-0.json`, describe one report per run, and SHALL NOT advertise `{worker}` substitution or per-worker report files. The `-0` suffix SHALL be documented as a legacy file name rather than a worker index.

#### Scenario: Reporter options table shows the real default

- **WHEN** a consumer reads the Playwright or Vitest reporter options in `README.md`
- **THEN** the `offlineReportPath` default is `./crvy-rprtr-0.json`
- **AND** no `{worker}` placeholder is presented as supported

#### Scenario: Offline mode guide describes one report

- **WHEN** a consumer reads `docs/offline-mode.md`
- **THEN** the guide describes one offline JSON report per run rather than one file per worker
- **AND** it does not present `TEST_WORKER_INDEX` as file-naming input
