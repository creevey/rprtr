# Design

## Context

See `proposal.md` — Why. Current state that shapes the approach:

- `RunController` (`src/server/run-controller.ts`) is the single choke point for every UI-launched run: it owns the run context, filters, the `LaunchSpec` returned by the launcher, and the child lifecycle (`start`, `stop`, `handleChildExit`).
- `LaunchSpec` (`src/server/run-launcher.ts`) is `{ cmd, args, env }`. Docker image and container name live inside `createDockerLauncher` (`src/server/docker-launcher.ts:252`) and are not visible to the controller; parsing them out of `args` would be brittle.
- `ChildProcessLike.on('exit')` models `(code)` only; the signal a child died on is dropped before `handleChildExit`.
- The server logs run lifecycle in `handlers.ts` unconditionally; `RunController` already has an injectable `warn` sink and uses it for non-zero exits.

## Goals / Non-Goals

**Goals:**

- One launch record and one exit record per UI-launched run, always on, launcher-agnostic.
- Details come from first-class values (context, filters, spec, launcher description), never from parsing command lines.
- Testable through injected sinks and an injected clock; no new activation surface.

**Non-Goals:**

- Full argv/env capture, mount checks, child output capture, container retention — the later debug-mode change.
- Discovery/listing and sidecar readiness records.
- Any change to `RunContext`, run semantics, artifacts, or the live UI.

## Decisions

### D1 — Records are produced by `RunController`

It is the only place that sees context + filters + launch spec + child lifecycle together, for both runners and both launch paths. Alternatives: launchers logging themselves (fragments the format, misses spawn/exit lifecycle), handlers (misses spawn failures), a wrapper around `spawn` (has no run context). None covers the whole record; none is chosen.

### D2 — Launch description is a launch datum, not parsed args

`LaunchSpec` gains an optional `container?: { image: string; name: string }` field, filled by the docker launcher at `launch()` time (both values are already in scope there). The controller renders it when present. Alternatives: special-casing `launcher.mode === 'docker'` in the controller (couples controller to backend details), regex-extracting `--name`/image from `args` (brittle, breaks on arg-order changes), a `describe()` method per launcher (more interface surface for the same data). After the docker-backend rework the same field is filled from the prepared sidecar state, so the record survives the refactor without touching this seam.

### D3 — Exit signal flows through the existing `exit` event

`ChildProcessLike.on('exit')`'s callback becomes `(code: number | null, signal?: string | null)`, forwarded by `createRealSpawn()` from Node's real event. Existing fakes that invoke `cb(1)` keep compiling and behaving. Duration is measured with a new optional `now?: () => number` dependency (default `Date.now`) captured at spawn and read at exit, so tests can pin it. Alternatives: a second `close` event (duplicate lifecycle edges), reading `process.hrtime` directly (untestable), dropping signal (loses the stop-path record the spec requires).

### D4 — Two sinks, matching existing console semantics

`RunControllerDeps` gains an optional `log?: (message: string) => void` (default `console.log`), and the existing `warn` sink carries non-zero terminations. This mirrors the `warn`/`log` sink convention already used by discovery, the test-file watcher, and reporter modules, and keeps the records assertable in unit tests without console spying.

Record shapes (greppable, one line each):

- launch: `[RunController] run start mode=<mode> runner=<kind> cwd=<dir> config=<file> tests=<n> update=<bool>` plus ` image=<tag> container=<name>` when present.
- exit: `[RunController] test run exited with code <n> (<ms>ms)` at `log` level for zero and `warn` level for non-zero; `[RunController] test run terminated by <SIGNAL> (<ms>ms)` at `warn` level when a signal is known.

The existing `test run exited with code <n>` phrasing is preserved at the front of the exit warning so existing operator muscle memory and troubleshooting notes keep matching.

### D5 — Sensitive content is excluded by construction

The records enumerate their fields; no environment values and no command arguments are ever included. Exit records reuse the existing wording. This is what the privacy requirement in the spec delta tests.

## Risks / Trade-offs

- [Extra terminal line per run] → One line, consistent with the run begin/complete chatter already emitted; no log level needed because the change is explicitly always-on.
- [`LaunchSpec` grows a diagnostics-only field] → Optional and small; the alternative (arg parsing) couples the record to launcher internals this design exists to avoid.
- [Signal may be unknown on some hosts/containers] → The record falls back to the exit code; the spec requires "code or signal", not both.
- [Clock seam added to a core type] → Optional with a default; only the controller reads it.

## Migration Plan

Additive terminal output; no configuration, data, or API migration. Rollback is a code revert — records leave no persisted state.

## Open Questions

None that affect the specs, approach, or tasks. Whether discovery listings and sidecar readiness get analogous records is deliberately deferred to the debug-mode change.
