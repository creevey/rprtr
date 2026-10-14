# Tasks

## 1. Prerequisite check

- [x] 1.1 Confirm the base landed: `run-launch-diagnostics` provides the controller `log` sink and `LaunchSpec.container`, and `playwright-docker-browser` provides the shared sidecar-backed docker path. Verify: `cd tests && bun test run-controller.test.ts browser-sidecar.test.ts` passes against the current tree; if not, stop and implement those changes first.

## 2. Activation and propagation

- [x] 2.1 Write failing tests in a new `tests/debug-log.test.ts`: the reporter gate enables on `CRVY_RPRTR_DEBUG` or non-empty `DEBUG`; `createDebugLogger` emits only when enabled and only through the injected sink. Verify: `bun run build && cd tests && bun test debug-log.test.ts` (new cases fail).
- [x] 2.2 Implement the `createDebugLogger` factory and the widened reporter gate in `src/debug-log.ts`; keep existing call sites untouched. Verify: task 2.1 tests pass.
- [x] 2.3 Write failing CLI tests in `tests/cli.test.ts`: `--debug` parses to `debug: true`, defaults to unset, and appears in the help text token list. Verify: `cd tests && bun test cli.test.ts` (new cases fail).
- [x] 2.4 Implement the `--debug` flag, `ServerOptions.debug`, and the startup `DebugSettings` resolution in `src/cli.ts`, `src/server/app.ts`, and `src/server/server-factories.ts`; `DEBUG` alone must not enable server-side debug. Verify: task 2.3 tests pass; `bun run typecheck`.
- [x] 2.5 Write failing tests that a debug-enabled server exports `CRVY_RPRTR_DEBUG` into every spawn: local run env (`run-controller.test.ts`), container vector (`docker-launcher.test.ts` or its post-refactor successor), and listing spawn env (`playwright-discovery.test.ts`). Verify: `bun run build && cd tests && bun test run-controller.test.ts playwright-discovery.test.ts` (new cases fail).
- [x] 2.6 Implement explicit `CRVY_RPRTR_DEBUG` injection in the launch env and container arg builder when debug is on; flag-only activation must cover containers too. Verify: task 2.5 tests pass.

## 3. Debug records

- [x] 3.1 Write failing tests for the redaction helper (`tests/debug-redact.test.ts`): allowlisted names carry values, credential-shaped names never do, URL userinfo and token-shaped query parameters are masked. Verify: `bun run build && cd tests && bun test debug-redact.test.ts` (new cases fail).
- [x] 3.2 Implement the redaction helper and the shared `key=value` record formatter in `src/debug-log.ts` (or a sibling module). Verify: task 3.1 tests pass.
- [x] 3.3 Write failing tests that a debug run records the exact command and arguments and the environment names (allowlisted values only), for Playwright and Vitest contexts. Verify: `cd tests && bun test run-controller.test.ts` (new cases fail).
- [x] 3.4 Implement the launch-vector record in `RunController.start` through the injected debug sink. Verify: task 3.3 tests pass.
- [x] 3.5 Write failing tests that a container launch record names image, container, pinned platform, and each bind-mount source with existence at launch. Verify: `cd tests && bun test docker-launcher.test.ts` (new cases fail).
- [x] 3.6 Implement container-detail records at the container-vector builder (post-refactor: the sidecar launch path). Verify: task 3.5 tests pass.
- [x] 3.7 Write failing tests that preparation phases (probe, pull, sidecar start, readiness) are recorded with start/completion, using fake docker execs. Verify: `cd tests && bun test browser-sidecar.test.ts` (new cases fail).
- [x] 3.8 Implement preparation-phase records in the launcher/sidecar preparation path. Verify: task 3.7 tests pass.
- [x] 3.9 Write failing tests that a failed listing records command, reason, exit code, and a bounded stderr excerpt; then implement it in `readPlaywrightListOutcome`/the Vitest equivalent, threading the debug sink through discovery. Verify: `cd tests && bun test playwright-discovery.test.ts vitest-discovery.test.ts`.

## 4. Child output capture

- [x] 4.1 Write failing tests in `tests/run-controller.test.ts`: with debug on, the spawn call uses piped stdio and mirrors stdout/stderr lines with stream prefixes; a child writing nothing is recorded as writing nothing; without debug, `stdio: 'inherit'` is unchanged. Verify: `bun run build && cd tests && bun test run-controller.test.ts` (new cases fail).
- [x] 4.2 Extend `ChildProcessLike` with optional stdout/stderr handles, attach them in `createRealSpawn`, and implement line-buffered mirrored capture in debug mode only. Verify: task 4.1 tests pass; `bun run typecheck`.

## 5. Retention and sidecar evidence

- [x] 5.1 Write failing tests: debug container vectors omit `--rm` and carry the debug label; a stale debug container is force-removed before a launch reusing its name; debug-off vectors are byte-identical to today. Verify: `bun run build && cd tests && bun test docker-launcher.test.ts browser-sidecar.test.ts` (new cases fail).
- [x] 5.2 Implement debug retention (args, label, stale-removal) at the container-vector builders. Verify: task 5.1 tests pass.
- [x] 5.3 Write failing tests in `tests/browser-sidecar.test.ts`: a readiness failure records image, name, inspect state, and a bounded log tail before force-removal; debug retains the container; an already-removed container still fails as `docker-unavailable`. Verify: `cd tests && bun test browser-sidecar.test.ts` (new cases fail).
- [x] 5.4 Implement sidecar evidence capture before removal and debug retention. Verify: task 5.3 tests pass.
- [x] 5.5 Extend the Docker-gated integration coverage: a debug-mode run records its launch vector, and an induced failure retains a labeled container with recorded inspect commands. Verify: `CRVY_DOCKER_SMOKE=1 cd tests && bun test docker-smoke.test.ts` (skips without a daemon, per the existing convention).

## 6. Invariants, docs, and gate

- [x] 6.1 Add sentinel-secret tests spanning activation to record output: no credential-shaped value, token-bearing URL, or non-allowlisted environment value appears in any debug record; the same run request yields identical selection, results, and refusal outcomes with debug on and off. Verify: `cd tests && bun test run-controller.test.ts debug-log.test.ts debug-redact.test.ts`.
- [x] 6.2 Update docs: `README.md` (Server CLI Options row for `--debug`; Docker Mode retention and the labeled cleanup one-liner), `docs/offline-mode.md` (environment variable table row for `CRVY_RPRTR_DEBUG`), `docs/docker-manual-smoke-test.md` (troubleshooting row pointing at debug mode). Verify: `bun run format:check`.
- [x] 6.3 Full gate: run `bun run check`; run `bun run test:playwright` only if the debug work touched browser-visible behavior. Verify: `bun run check` exits 0 and the docs edits from task 6.2 are present.
