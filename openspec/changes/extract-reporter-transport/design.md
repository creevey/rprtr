# Design: extract-reporter-transport

## Context

`src/reporter.ts` currently mixes two concerns:

- **Provider-agnostic machinery**: WebSocket connect/queue/offline-mode, `send()` with `runEvents` recording, CI-offline constructor switch, CI deferral flush, teardown wait, static-HTML + offline-JSON writes.
- **Playwright-specific logic**: `sendRegister` (snapshotDir/testDir/templates), `extractScreenshotDeclarations` from step titles, `baselineInput` → `resolveBaselineTargets`, `resolveBrowserLabel`, title-path conventions, portable-artifacts and content-addressed baseline copying.

File-level ops are already extracted (`reporter-artifact-ops.ts`, `reporter-helpers.ts`); what remains entangled is stateful machinery (connection + mode + event buffer). No existing module covers that — `reporter-artifact-ops.ts` is stateless file ops only. This change creates that module so a future Vitest reporter can reuse it (see follow-up change proposals; not part of this one).

## Goals / Non-Goals

**Goals**

- One new internal module owning connection/mode/event state; `reporter.ts` becomes a thin Playwright adapter over it.
- Byte-for-byte behavioral equivalence: identical wire messages, identical file outputs, identical log lines, identical timing (teardown race, flush order).
- Existing tests pass without modification (offline, artifact-ops, reporter-level suites).

**Non-Goals**

- No API/option/type renames (`CrvyRprtr`, `CrvyRprtrOptions` stay).
- No transport export in the package `exports` map; it stays internal.
- No improvements to connection handling, retry, or logging — refactor only.

## Decisions

### D1: Transport is a class with explicit lifecycle (`start` / `send` / `finish`)

`new ReporterTransport(options)` → `start()` (mkdir + connect) → `send(msg)` → `finish(runEnd)`. Alternative considered: free functions over a shared state object — rejected because the state (ws, queue, mode flags, runEvents) is exactly what a class encapsulates and both current reporters are class-shaped.

Options: `serverUrl`, `screenshotDir`, `offlineReportPath`, `reportHtmlPath`, `workerIndex` (env default), `ci` (constructor-offline switch). Constructor behavior preserved exactly: `ci: true` ⇒ offline from construction.

### D2: Transport owns events, connection, and artifact writes; adapter owns Playwright deferral

- **Transport**: WS lifecycle, offline toggle, send-queue, `runEvents` recording (mirrors current `send()`), `writeOfflineReport`/`writeStaticArtifact` calls, teardown wait. Wraps `reporter-artifact-ops.ts` functions; adds no new file logic.
- **Adapter**: register payload, declarations, baseline targets, browser labels, `pendingArtifacts` deferral queue. The CI deferral buffer stays in the adapter because `PendingPortableArtifact` carries `ResolvedBaselineTarget[]` (Playwright-typed); the adapter calls `transport` persistence primitives at flush time.

Alternative considered: pushing deferral into transport with a generic callback — rejected; it would force provider types through the transport interface for zero current reuse.

### D3: Naming — `ReporterTransport` in `src/transport.ts`

Alternatives: `CreeveyTransport` (spike's name) — rejected, "Creevey" branding is package-level, not module-level; `ConnectionManager` — rejected, it also owns offline persistence and event buffering.

### D4: Move, don't improve

Any bug or awkwardness noticed mid-move is recorded as a comment-free follow-up note in this change's tasks, not fixed in the refactor commit. Keeps the diff mechanically reviewable (`git diff` should read as block moves).

## Risks / Trade-offs

- [Subtle behavior drift during the move (ordering, log text, teardown timing)] → Mitigation: move-only edits; existing suites (`tests/offline.test.ts`, artifact-ops, reporter tests) must pass unmodified; full `bun run check` + `bun run test:playwright` gate.
- [Transport interface guessed wrong for Vitest follow-up] → Mitigation: interface mirrors the spike-validated `CreeveyTransport` lifecycle (`start/send/finish`); adjusting a private internal later is cheap.
- [knip flags transport exports as unused] → Mitigation: transport is imported by `reporter.ts`; only the class + options type exported from the module, nothing re-exported from package entries.

## Migration Plan

Single PR, single commit series; no deploy or data migration. Rollback = revert PR. Consumer-visible surface (exports map, dist layout, wire format, artifact formats) unchanged — esbuild still bundles from `src/reporter.ts`.

## Open Questions

None blocking. Exact method names (`start`/`finish` vs alternatives) settle during implementation without affecting approach or tasks.
