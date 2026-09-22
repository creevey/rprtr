# Proposal: extract-reporter-transport

## Why

`src/reporter.ts` has regrown into a monolith (299 lines) that entangles provider-agnostic machinery — WebSocket lifecycle, offline-mode queue, run-event recording, CI deferral, static/offline artifact writes — with Playwright-specific logic (config registration, step-title declaration extraction, snapshot-resolver input). A second provider reporter (Vitest browser mode, planned next) needs the generic machinery as a shared seam; extracting it first, as a pure refactor, keeps that feature diff reviewable and leaves Playwright behavior provably untouched.

## What Changes

- Extract a provider-agnostic transport (new `src/transport.ts`) owning: WebSocket connect/queue/offline-mode toggling, `send()` with run-event recording, CI deferral buffer + flush, teardown wait, and `writeOfflineReport`/`writeStaticArtifact` invocation.
- Slim `CrvyRprtr` (`src/reporter.ts`) to a Playwright adapter: config registration, declaration extraction, baseline-resolution input, browser-label/title-path conventions, portable-artifacts wiring.
- Reuse existing extracted file ops (`reporter-artifact-ops.ts`) and helpers (`reporter-helpers.ts`) unchanged; the transport composes them.
- No public API, wire-format, CLI, UI, or artifact format changes. **No behavior change of any kind** — this is a structural refactor.

## Capabilities

### New Capabilities

_None._ Behavior does not change; specs describe behavior, so no spec is created or modified. `skip_specs: true` is set in `.openspec.yaml`.

### Modified Capabilities

_None._ No existing capability specs exist under `openspec/specs/` yet, and no requirements change.

## Impact

- **Code**: `src/reporter.ts` (restructured), new `src/transport.ts`. `reporter-artifact-ops.ts`, `reporter-helpers.ts`, `reporter-utils.ts`, `snapshot-path-resolver.ts` untouched. Build entry points unchanged (`src/reporter.ts` remains the sole reporter entry).
- **Public exports**: unchanged (`.`, `./server`, `./rendering`, `./types`).
- **Docs**: none affected (`docs/offline-mode.md` behavior is unchanged; verified by existing offline tests).
- **Verification**: existing suites are the gate — `bun test` (offline, reporter, artifact-ops tests) after `bun run build`, plus `bun run check` and `bun run test:playwright`.

## Non-goals

- No Vitest or other-provider reporter (that is a follow-up change building on this seam).
- No rename of `CrvyRprtr`, no changes to `CrvyRprtrOptions`, no new export surface for the transport.
- No changes to server-side handling, schemas, or approval flow.
- No CI-deferral or portable-artifacts behavior tuning, even where the extraction makes it tempting.
