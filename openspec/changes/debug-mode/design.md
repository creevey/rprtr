# Design

## Context

See `proposal.md` — Why. Current state that shapes the approach:

- `src/debug-log.ts` is a module-level gate (`DEBUG` non-empty) with `log`/`logError` used only by reporter-side modules; the server never reads it.
- Server components take injectable sinks: `RunControllerDeps.warn`, discovery `deps.log`, the test-file watcher `options.log`. Records added by `run-launch-diagnostics` use a `log` sink on the controller.
- `RunController` spawns with `stdio: 'inherit'`; `ChildProcessLike` models `exit`/`error`/`kill` only, so nothing can observe child output that a piped server stdout swallows.
- Docker env forwarding is name-only `-e NAME` with a denylist (`docker-env.ts`); names come from the docker CLI process env. Container vectors carry `--rm` in `buildDockerRunArgs` and the sidecar builder; `BrowserSidecar` force-removes the container before throwing `DockerUnavailableError`, discarding evidence.
- Listing outcomes are an enum (`exit | parse | spawn | timeout`); stdout is parsed, stderr is dropped, exit codes are not kept.
- `playwright-docker-browser` will retire the in-container Playwright path and share the sidecar between runners; this change's container seams are written for `BrowserSidecar` and any container vector, not `buildDockerRunArgs` internals.

## Goals / Non-Goals

**Goals:**

- One activation decision per process, propagated to every spawned process so a single switch covers server, reporter, listings, and containers.
- Records built from first-class values and injected sinks; unit-testable without console spying or Docker.
- Capture and retention that never alter run semantics, results, or artifacts.
- Redaction enforced at composition time, so every sink inherits it.

**Non-Goals:**

- UI or artifact surfaces, file/JSONL sinks, remote collection.
- Changing the run-output passthrough; debug capture observes the same bytes.
- Orchestrating Playwright's `DEBUG` namespaces.

## Decisions

### D1 — Activation is resolved once at startup and injected

A `DebugSettings` value (`{ enabled: boolean }`, plus a pre-bound `sink`) is resolved in `server-factories`/`createServerApp` from `ServerOptions.debug` and `CRVY_RPRTR_DEBUG`, then passed to `RunController`, launchers, `BrowserSidecar`, and discovery as an optional `debug` dependency, mirroring the existing `warn`/`log` sink convention. Alternatives: reading the environment at each record site (untestable, inconsistent), a module-level global in `debug-log.ts` for the server (breaks test isolation), reusing `DEBUG` (rejected — see the spec's activation scenarios).

### D2 — `debug-log.ts` grows a factory; the reporter gate keeps `DEBUG`

`debug-log.ts` gains `createDebugLogger({ enabled, sink })` used by the server; the existing `log`/`logError` remain for reporter call sites and their gate becomes `CRVY_RPRTR_DEBUG || DEBUG`. This keeps the reporter-side legacy alias without letting Playwright's `DEBUG` switch on server retention. A small `formatRecord(prefix, fields)` helper renders `key=value` lines consistently for both tiers (avoids duplicate formatting code under jscpd).

### D3 — Propagation is explicit, never inherited by accident

When debug is on, the launcher's spawn environment gets `CRVY_RPRTR_DEBUG=1` explicitly: `buildSpawnEnv` for local runs and listings, and the container arg builder adds `-e CRVY_RPRTR_DEBUG` for runs whose test process is containerized (legacy path) or for the sidecar. Relying on name-only forwarding of a host variable would fail for the flag-only case, because `--debug` never enters `process.env`. Alternatives: mutating `process.env` at startup (side effects on the host process and every child — invisible and hard to test), documenting the env var only (defeats the CLI flag).

### D4 — Capture is a debug-only spawn mode with a chunked mirror

With debug on, `RunController` spawns `['ignore','pipe','pipe']` and mirrors complete lines to the server terminal (`[run>]`, `[run!]`), tracking byte counts; the remainder is flushed at exit and a zero-byte child is recorded. `ChildProcessLike` gains optional `stdout`/`stderr` handles so fakes can emit chunks. The run-output passthrough is unaffected: it writes into the child's own streams, which the wrapper observes exactly once. The trade-off — the child loses TTY detection, so Playwright output becomes plain lines while debugging — is documented. Alternatives: `inherit` plus a second observer (impossible), a pty (platform-specific, new dependency territory), always-on capture (changes every run's behavior).

### D5 — Retention: labels, stale-removal, and snapshot-before-remove

Debug launches omit `--rm` and add `--label crvy-rprtr.debug=1`; before a launch reusing a container name under debug, the stale container is force-removed (the sidecar path already does this; the run path gains it under debug). The record includes `docker logs`/`docker inspect` commands. Independently of debug, `BrowserSidecar` records image, name, `docker inspect` state, and a bounded `docker logs --tail` **before** its force-remove, and skips removal in debug. Degradation when the container self-removed despite `--rm` is handled by the spec's graceful scenario. Cleanup stays explicit: the label supports `docker rm -f $(docker ps -aq --filter label=crvy-rprtr.debug=1)`, documented in README. Alternatives: snapshot-only for the run path (unreliable with `--rm` — the container is gone before the CLI exits), `docker events` streaming (racy for sub-second exits), keeping containers unconditionally (wrong default).

### D6 — Listing diagnostics ride the existing listing seam

`readPlaywrightListOutcome` (and the Vitest equivalent) gains stderr accumulation and an optional debug sink; on failure it records command, cwd, reason, exit code when known, and a bounded stderr excerpt (~2 KB, line-bounded). Control flow and the `ListFailure` enum are unchanged; discovery passes its debug sink through its existing options object. Alternatives: widening `ListResult` with diagnostics (couples control flow to presentation), logging only at the discovery line (loses the command and stderr).

### D7 — Redaction at composition time

A `redact` helper decides, per environment variable, whether the name is recorded, whether a value is recorded (fixed allowlist: `CI`, `DEBUG`, `NODE_ENV`, `NODE_OPTIONS`, `CRVY_RPRTR_*`), and masks values whose names match credential shapes (`*TOKEN*`, `*SECRET*`, `*KEY*`, `*PASSWORD*`, `*AUTH*`) plus URL userinfo and `token`-shaped query parameters. Record builders call it; sinks never see raw `process.env`. Allowlist and masks are unit-tested with sentinel values.

### D8 — Public surface

`--debug` (boolean) in `src/cli.ts` with a help line; `ServerOptions.debug?: boolean` in `src/server/app.ts`. No new exports, bins, or peer dependencies. The flag only enables; there is no `--no-debug`, matching the enable-only style of existing mode flags.

## Risks / Trade-offs

- [Children lose TTY detection under debug] → Debug-only, documented; output format is intentionally line-oriented for logs.
- [Retained containers accumulate] → Labels, stale-removal before reuse, documented one-liner cleanup; disk cost is small compared to images.
- [Env allowlist drifts] → Allowlist and masks live in one helper with sentinel tests; names-only is the default posture.
- [More code in `RunController` and launchers] → Records compose in small helpers with injected sinks; max-lines lint acts as the split signal, per repo conventions.
- [Sequencing: `playwright-docker-browser` changes the container surface] → Container details are attached at the sidecar/launch-vector seams; the in-container-specific bits (explicit `-e CRVY_RPRTR_DEBUG`, run-container retention) shrink or vanish with that change, and nothing else depends on them.

## Migration Plan

Purely additive and opt-in. Default behavior is byte-identical to before except the unconditional sidecar failure evidence recorded by the modified capability. Rollback is disabling the flag/environment variable or reverting the release; retained debug containers are cleaned by label.

## Open Questions

None that affect the specs, approach, or tasks. A file/JSONL sink and `--debug` orchestration of Playwright `DEBUG` namespaces remain deliberate non-goals for a possible follow-up.
