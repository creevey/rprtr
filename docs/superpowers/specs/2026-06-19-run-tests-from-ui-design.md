# Run Tests From UI Design

**Date:** 2026-06-19
**Topic:** Let users start and stop Playwright runs from the Crvy Rprtr web UI by spawning `playwright test` as a child process, reusing the existing reporter event flow.

## Overview

The Crvy Rprtr sidebar already renders Start (▶) and Stop (■) buttons (`src/client/components/Sidebar.svelte:120-136`), but the handlers in `src/client/App.svelte:279-280` are empty stubs and the buttons are gated behind `{#if !isReport && !isUpdateMode}` (`Sidebar.svelte:120`) — a dead branch because `isReport` is set to `true` in both bootstrap paths (`src/index.ts:39, 57`). The server has no notion of triggering a run; `reportData.isRunning` is only ever flipped by reporter events (`src/server/handlers.ts:28, 80`).

This design wires the existing UI scaffold to a new server-side `RunController` that spawns `playwright test` as a child process. The spawned process loads the user's existing `playwright.config` (which already lists `@crvy/rprtr` as a reporter), and the reporter reconnects to the server over WebSocket to emit the existing `register`, `test-begin`, `test-end`, and `run-end` events. No new reporter event types are introduced; every existing live-update code path is reused.

## User Story

As a developer iterating on screenshot tests, I want to click Start in the Crvy Rprtr sidebar to run my suite (or Stop to interrupt it) without leaving the browser tab where I review diffs and approve baselines, so that the review-and-rerun loop stays inside one window during local development.

## Background: verified facts

- **No public Playwright programmatic API.** The runner internals (`TestRunner`, `TestServer`, `TestServerInterface`) live under `packages/playwright/src/runner/` and are not exported by `@playwright/test`. Issue microsoft/playwright#8027 confirmed that running tests programmatically is "currently not yet possible" and the maintainers closed it.
- **Playwright UI mode architecture.** `playwright test --ui` starts a `TestServerDispatcher` (`packages/playwright/src/runner/testServer.ts`) that implements a private JSON-RPC `TestServerInterface` over WebSocket with methods `listTests`, `runTests({ testIds, locations, projects, ... })`, `stopTests`. The React frontend (`uiModeView.tsx`) drives it via `TestServerConnection`. The protocol has already changed materially between Playwright 1.51 and 1.58 (e.g. `playwright-core/lib/server` import paths, `_serializer` field, `coreServer` extraction), so depending on it externally is fragile.
- **Stable external interfaces are the `playwright test` CLI and the Reporter extension point.** Both are already used by this project. The CLI supports stable filters: positional `file:line` arguments, `-g "title"`, `--project <name>`, `--config <path>`.
- **Playwright `test.id` values are run-specific.** They are regenerated per `playwright test` invocation and are not a stable cross-run filter. The only stable per-test filters are `file:line` and `-g` (titles not guaranteed unique).
- **The reporter already reconnects to whatever server URL it is given.** `CrvyRprtrOptions.serverUrl` defaults to `ws://localhost:3000` (`src/reporter.ts:60`). A spawned `playwright test` child that loads `@crvy/rprtr` will reconnect automatically.
- **The reporter captures `config.configFile` in `onBegin`** (`src/reporter.ts:73`) for `configDir` derivation but does not currently forward it to the server.
- **The `register` message** (`src/schemas.ts:189-196`, sent from `src/reporter.ts:117-129`) already exists and already conveys `playwrightSnapshotDir`, `playwrightTestDir`, and the two path templates. It is the natural carrier for the new `configFile` + `cwd` fields.
- **`ServerApp.close()` is currently a no-op** (`src/server/app.ts:296`). A spawned child needs to be killed on shutdown.

## Goals

1. Wire the existing Start/Stop sidebar buttons to actually start and stop `playwright test` runs.
2. Reuse the user's existing `playwright.config` (with `@crvy/rprtr` as a reporter); require no second config or extra user wiring.
3. Reuse the existing reporter → server → browser event flow; introduce no new reporter event types.
4. Stay within Playwright's stable public surface (CLI + Reporter contract) so the feature survives Playwright minor bumps.
5. Hide the feature in artifact-review mode and whenever no reporter has registered.
6. Cover all observable behavior with `bun:test` unit tests using the existing mock-context pattern; no Playwright integration harness.

## Non-Goals

1. Per-test "rerun this test" buttons in the tree. Deferred to a follow-up; the v1 trigger is the global Start button only. The server endpoint accepts `files` so a follow-up can add the UI without API changes.
2. Watch mode, multiple queued runs, concurrent-project runs, or running tests across multiple Playwright configs.
3. Surfacing child-process stdout/stderr in the UI. Playwright's own output goes to the server's terminal where the user can already see it.
4. Driving runs through Playwright's internal `TestServerInterface`. Rejected — see Decision D2.
5. Auto-discovering the Playwright config from `process.cwd()`. The reporter tells us; no walking the filesystem.
6. Running tests when the server is pointed at a downloaded CI artifact (no source tree). Out of scope by Decision D1.

## Scope and Operating Context

### Decision D1 (accepted)

The run-from-UI feature targets **live dev workflow only**: the server runs in the user's project directory alongside their source code and `playwright.config`, and a reporter connects from an active Playwright session. In CI/artifact-review mode (server pointed at `report.json` + `screenshots/` with no source tree), the Start/Stop buttons remain hidden. The presence of a registered `configFile` + `cwd` from a live reporter is the single signal that the feature is available.

### Decision D2 (accepted)

The server spawns `playwright test` as a child process. Rejected alternatives:

- **Spawn `playwright test --server` and drive via `TestServerInterface`.** More structured than raw CLI args, but the protocol is private, has no shipped type definitions, and has already changed materially between Playwright 1.51 and 1.58 (`_serializer` field semantics, `playwright-core/lib/server` → `coreServer` extraction, `wrapReporterAsV2`). Coupling to it would silently break across minor releases.
- **In-process deep-import of `TestRunner` from `@playwright/test`.** Fastest, but uses completely private modules, executes user test code inside the server process (crash/isolation risk), and is explicitly discouraged by Playwright maintainers (microsoft/playwright#8027).

### Decision D3 (accepted)

Config discovery is via the reporter's existing `register` message, extended with `configFile` and `cwd`. The reporter has both in `onBegin` (`src/reporter.ts:73`). No new CLI flags, no auto-discovery from `process.cwd()`. The Start button activates automatically once a reporter has registered config paths.

### Decision D4 (accepted)

Safety gating is implicit: the feature is enabled once a reporter has registered, with no separate opt-in flag and no loopback origin check. This matches the existing trust posture where `/api/approve` (`src/server/routes.ts:69`) already writes baseline files to the filesystem from any localhost requester. The server's localhost binding is the implicit trust boundary.

### Decision D5 (accepted)

Single source of truth for `isRunning`. The `RunController` sets `reportData.isRunning = true` on spawn and `= false` on child exit. Existing reporter-driven handlers (`handleTestBegin`, `handleRunEnd`) continue to also set it. The two paths agree because they observe correlated events from the same run, and the child-exit handler is the safety net that resets state even if the reporter never connects.

## Architecture and Data Flow

### Start flow

1. Browser `POST /api/run` with optional body `{ files?: string[], project?: string }`. Empty body = run the whole suite.
2. `RunController.start` refuses if (a) no reporter has registered `configFile` + `cwd`, or (b) a run is already in progress. The route returns 409 with `{ reason: 'no-config' | 'already-running' }`.
3. `RunController` spawns a child from the registered `cwd`:
   ```
   <bin> playwright test --config <absConfigPath> [<file:line> ...] [--project <name>]
   ```
   where `<bin>` is `node_modules/.bin/playwright` if present in the registered `cwd`, otherwise `npx`. The child inherits `process.env` plus `CRVY_RPRTR_SERVER_URL=ws://localhost:<port>` so the reporter inside the child connects back to this server rather than its default.
4. `RunController` stores the `ChildProcess`, sets `reportData.isRunning = true`, broadcasts `{ type: 'run-status', data: { running: true } }` to all browser clients.
5. The spawned Playwright loads the user's `playwright.config`, which lists `@crvy/rprtr` as a reporter. That reporter connects to `ws://localhost:<port>` and emits `register → test-begin → test-end → run-end` exactly as it does today. Existing handlers process those events; all connected browsers see live updates as today.
6. On child exit (any status code), `RunController` sets `reportData.isRunning = false`, broadcasts `{ type: 'run-status', data: { running: false } }`, clears the `ChildProcess` reference. If the reporter never connected (e.g., user's config doesn't actually list `@crvy/rprtr`, or Playwright crashed at boot), the child exit is the safety net that resets state.

### Stop flow

1. Browser `POST /api/stop`.
2. `RunController.stop` refuses with 409 `{ reason: 'not-running' }` when no child is tracked.
3. Otherwise sends `SIGTERM` to the tracked child. Playwright handles SIGTERM with graceful shutdown.
4. After a 5-second grace period, if the child has not exited, sends `SIGKILL` and logs a warning.
5. Child exit triggers step 6 of the start flow.

## Server Components

### New module: `src/server/run-controller.ts`

A single class owning the run lifecycle, isolated from `app.ts` so it can be tested by injecting a fake spawner and broadcaster:

```ts
export interface RunContext {
  configFile: string
  cwd: string
}

export interface RunFilters {
  files?: string[]
  project?: string
}

export type StartResult =
  | { ok: true }
  | { ok: false; reason: 'no-config' | 'already-running' | 'spawn-failed'; message?: string }

export type StopResult = { ok: true } | { ok: false; reason: 'not-running' }

interface RunControllerDeps {
  getRunContext(): RunContext | null
  port: number
  broadcast(message: ClientWebSocketMessage): void
  setReportRunning(running: boolean): void
  spawn(cmd: string, args: string[], opts: SpawnOptions): ChildProcessLike
  timers: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout }
}

export class RunController {
  constructor(deps: RunControllerDeps)
  start(filters: RunFilters): StartResult
  stop(): StopResult
  dispose(): void
  get isRunning(): boolean
}
```

Where `ChildProcessLike` is a minimal structural interface (`on(event: 'exit', cb: (code: number | null) => void): void; kill(sig: string): void`) so tests can supply a stub without depending on Node's `child_process` types.

Responsibilities:

- Translate `filters` to CLI args. `files` become positional `file:line` arguments verbatim; `project` becomes `--project <name>`; empty filters = run all.
- Resolve `<bin>`: `node_modules/.bin/playwright` if it exists in the registered `cwd`, else `npx`. When using `npx`, args become `['npx', 'playwright', 'test', ...]`; when using the local binary, args become `['<abs>/node_modules/.bin/playwright', 'test', ...]`.
- On spawn: stash the child, call `setReportRunning(true)`, broadcast `run-status: { running: true }`, attach the `exit` listener.
- On `exit`: call `setReportRunning(false)`, broadcast `run-status: { running: false }`, clear the child reference, clear any pending SIGKILL timer.
- `stop()`: if no child, return `{ ok: false, reason: 'not-running' }`. Otherwise send `SIGTERM`, schedule a 5-second SIGKILL via `deps.timers.setTimeout`. Child exit fires step (6) of the data flow.
- `dispose()`: called from `ServerApp.close()`. If a child is tracked, `SIGKILL` it immediately (no grace) so server shutdown is not blocked.

### Reporter change: `src/reporter.ts`

Extend `sendRegister` (line 117) to include `configFile` and `cwd`:

```ts
private sendRegister(config: FullConfig): void {
  const snapshotDir = this.playwrightSnapshotDir ?? config.projects[0]?.snapshotDir
  const testDir = this.playwrightSnapshotDir === undefined ? config.projects[0]?.testDir : undefined
  this.send({
    type: 'register',
    data: {
      playwrightSnapshotDir: typeof snapshotDir === 'string' ? snapshotDir : undefined,
      playwrightTestDir: typeof testDir === 'string' ? testDir : undefined,
      playwrightSnapshotPathTemplate: this.playwrightSnapshotPathTemplate,
      playwrightToHaveScreenshotPathTemplate: this.playwrightToHaveScreenshotPathTemplate,
      configFile: config.configFile,             // new
      cwd: config.rootDir ?? process.cwd(),      // new
    },
  })
}
```

`this.configDir` is already set in `onBegin` (line 73) as `dirname(config.configFile)` when a config file exists; the new `configFile` field is the raw `config.configFile` (may be `undefined` when Playwright is invoked without a config file, in which case `RunController` will refuse to start and the UI will keep the button hidden).

### Schema changes: `src/schemas.ts`

- `RegisterDataSchema` (line 190): add `configFile: z.string().optional()` and `cwd: z.string().optional()`. Old reporters without these fields still parse — they just leave the run feature disabled on the server.
- New outbound variant on `WebSocketMessageSchema` (line 133): `{ type: z.literal('run-status'), data: z.object({ running: z.boolean() }) }`.
- New request schema `RunRequestBodySchema = z.object({ files: z.array(z.string()).optional(), project: z.string().optional() })`.
- New response schemas:
  - `RunResponseSchema = z.union([z.object({ ok: z.literal(true) }), z.object({ ok: z.literal(false), reason: z.enum(['no-config', 'already-running', 'spawn-failed']), message: z.string().optional() })])`
  - `StopResponseSchema = z.union([z.object({ ok: z.literal(true) }), z.object({ ok: z.literal(false), reason: z.literal('not-running') })])`
- `ReportApiResponseSchema` and `ClientBootstrapDataSchema` gain `runEnabled: z.boolean()` and `isRunning: z.boolean()` (the latter already on `ReportDataSchema`; surface it to clients).

### Handler change: `src/server/handlers.ts`

`handleRegister` (line 109) now also persists `configFile` and `cwd` onto `ctx.routesContext` next to the existing `playwrightSnapshotDir` etc. These are the fields `getRunContext()` reads.

### Wiring: `src/server/app.ts`

- `createServerApp` instantiates one `RunController`, passing:
  - `getRunContext`: reads `configFile` + `cwd` from `routesContext`.
  - `port`: the resolved port.
  - `broadcast`: `(msg) => broadcastToBrowsers(wsClients, msg)`.
  - `setReportRunning`: `(running) => { reportData.isRunning = running }`.
  - `spawn`: real `child_process.spawn` adapter.
  - `timers`: real `setTimeout` / `clearTimeout`.
- `RunController` is added to `RoutesContext` so the new routes can reach it.
- `ServerApp.close()` (line 296, currently a no-op) now calls `runController.dispose()`.

### New HTTP routes: `src/server/routes.ts`

- `POST /api/run` → parse body with `RunRequestBodySchema`; call `runController.start(parsed)`; respond 200 `{ ok: true }` or 409 `{ ok: false, reason, message? }`. Spawn failures return 500 with `{ ok: false, reason: 'spawn-failed', message }`.
- `POST /api/stop` → call `runController.stop()`; respond 200 `{ ok: true }` or 409 `{ ok: false, reason: 'not-running' }`.
- `GET /api/report` response includes `runEnabled` (true iff a reporter has registered `configFile` + `cwd`).

## Client Components

### `src/index.ts`

- Read `runEnabled` and the current `isRunning` from the bootstrap/api response and pass them as new props into `App` alongside `liveUpdates` / `approvalEnabled`.

### `src/client/App.svelte`

- Add `runEnabled: boolean` to `Props` and `let { runEnabled, ... } = $props()`.
- Initialize `isRunning` from the bootstrap value instead of hardcoded `false`.
- Replace the empty stubs (line 279-280):
  ```ts
  async function handleStart(): Promise<void> {
    const res = await fetch('/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    if (res.status === 409) {
      const body = await res.json().catch(() => null)
      runMessage =
        body?.reason === 'already-running' ? 'A run is already in progress' : 'Connect a Playwright reporter first'
    }
  }
  async function handleStop(): Promise<void> {
    await fetch('/api/stop', { method: 'POST' })
  }
  ```
- Add `runMessage` local state for surfacing 409 reasons; clear it on the next `run-status` message.
- Pass `runEnabled` and `runMessage` down to `Sidebar`.
- In the existing WebSocket `$effect` (line 305), handle the new `run-status` message: set `isRunning = msg.data.running` and clear `runMessage`. This keeps multiple browser tabs in sync and reflects spawn/exit even when no test events have flowed yet.

### `src/client/components/Sidebar.svelte`

- Add `runEnabled: boolean` and `runMessage?: string` to `Props`.
- Replace the dead gate `{#if !isReport && !isUpdateMode}` (line 120) with `{#if runEnabled}`.
- Start/Stop buttons stay as-is (▶ / ■) — already correctly conditional on `isRunning`.
- When `runMessage` is set, render it inline under the header using the existing `approvalMessage` pattern as a style reference.

### Untouched

- `ResultsPage.svelte`, `BlendView`/`SwapView`/`SlideView`/`SideBySideView`, `Toggle`, `TreeItem` — no changes.
- The approval flow and baseline resolver — no changes.
- Offline mode and the static HTML artifact — no changes (the static artifact is `isReport: true`, which now means `runEnabled: false`).

## State, Concurrency, and Error Handling

### State machine (internal to `RunController`)

```
idle ──start()──▶ running ──stop()──▶ stopping ──(child exit)──▶ idle
                       └──(child exit)──▶ idle
```

`stopping` is server-internal; the UI only sees `running: true → false`. The Stop button is disabled by the client until `run-status: { running: false }` arrives.

### Concurrency rules

- `start()` while `isRunning === true` → 409 `{ reason: 'already-running' }`.
- `stop()` while `isRunning === false` → 409 `{ reason: 'not-running' }`.
- At most one `ChildProcess` reference is held. A new `start()` cannot preempt an existing run; the user must stop first.

### Error cases

| Scenario                                                                            | Handling                                                                                                                                                                                    |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Spawn fails (`ENOENT` — neither `node_modules/.bin/playwright` nor `npx` available) | `start()` catches synchronously, returns 500 `{ ok: false, reason: 'spawn-failed', message }`. `isRunning` is not flipped; no `run-status` broadcast.                                       |
| Child exits nonzero                                                                 | Log exit code. `run-status: { running: false }` broadcasts on exit. UI sees failure via normal `test-end`/`run-end` events, or via the exit broadcast if the reporter never connected.      |
| Reporter in spawned run never connects                                              | Child exit is the safety net; `isRunning` resets to `false`. UI may briefly show "running" with no test updates.                                                                            |
| `stop()` SIGTERM ignored                                                            | After 5s grace, SIGKILL. Log a warning. Continue to `idle` on exit.                                                                                                                         |
| Server shuts down mid-run                                                           | `ServerApp.close()` calls `runController.dispose()`, which `SIGKILL`s the child immediately (no grace) so shutdown is not blocked.                                                          |
| User's env has `CI=true` set                                                        | Spawned reporter enters offline mode (`src/ci.ts`); no events flow; child exit eventually resets state. This is documented as a known gotcha; the feature is intended for non-CI local dev. |
| User runs `playwright test` in another terminal simultaneously                      | Both the spawned run and the CLI run drive the same `isRunning` flag via reporter events. UI shows whichever events arrive. Acceptable for v1; not a supported workflow.                    |

### Reporting to clients

Every state transition broadcasts `{ type: 'run-status', data: { running: boolean } }` via the existing `broadcastToBrowsers`. Combined with the existing per-test events, this keeps all browser tabs consistent. The client treats `run-status` as authoritative for the sidebar button state.

## Testing Strategy

All new tests use the existing `bun:test` + mock-context pattern (`tests/server-handlers.test.ts:8-38` for the established style). No real Playwright, no real server, no real subprocess.

### `tests/run-controller.test.ts` (new)

The core seam. `RunController` accepts injectable `spawn`, `broadcast`, `getRunContext`, `setReportRunning`, and `timers` (for fake timers). Tests inject:

- A fake `spawn()` returning a stub object shaped like `ChildProcessLike` with a `kill()` spy and a manual `exit` event the test can fire.
- A `broadcast` collector (same pattern as the existing `MockWebSocket`).
- A `getRunContext()` stub returning `{ configFile, cwd }` or `null`.
- A `setReportRunning` spy.
- Fake timers via `timers: { setTimeout, clearTimeout }` for the SIGKILL grace test.

Cases:

1. `start()` with no registered config → `{ ok: false, reason: 'no-config' }`; no spawn, no broadcast, no `setReportRunning` call.
2. `start()` happy path → spawn invoked with `--config <abs>` + correct `cwd` + `CRVY_RPRTR_SERVER_URL` env var; `setReportRunning(true)` called; `run-status: { running: true }` broadcast; `isRunning === true`.
3. `start()` while already running → `{ ok: false, reason: 'already-running' }`; no second spawn.
4. `start({ files: ['t.spec.ts:42'] })` → positional arg appears verbatim in spawn args.
5. `start({ project: 'chromium' })` → `--project chromium` appears in args.
6. Child `exit` (code 0) → `setReportRunning(false)` called; `run-status: { running: false }` broadcast; child reference cleared.
7. Child `exit` (code 1) → same as above; nonzero code logged but not fatal to the controller.
8. `stop()` happy path → `SIGTERM` sent to the child; test then fires `exit`; state fully resets.
9. `stop()` SIGTERM-ignored path → after 5s (fake timer advanced), `SIGKILL` invoked once.
10. `stop()` when not running → `{ ok: false, reason: 'not-running' }`.
11. `dispose()` mid-run → child is `SIGKILL`ed immediately, no grace timer scheduled.

### `tests/server-handlers.test.ts` (extend)

`handleRegister` now persists `configFile` and `cwd` onto the routes context. Assert both fields land when present in the payload, and that older payloads without them do not corrupt existing context.

### `tests/server-routes.test.ts` (extend)

`POST /api/run` and `POST /api/stop` end-to-end against a `RunController` injected with the same fake as above. Cover the 200 and 409 paths. Assert `runEnabled` appears in `/api/report` and is `true` only after a `handleRegister` call that included config paths.

### `tests/register-message.test.ts` (new)

Schema-level: a reporter register payload including `configFile` and `cwd` parses cleanly under the extended `RegisterDataSchema`; old payloads without the new fields still parse (backward compatibility for reporters/servers on different versions).

### Out of scope

A Playwright-level integration test that actually spawns `playwright test` against a sample project. The project has no such harness today, such a test would be flaky in CI, and the seam-injected fake validates every observable behavior of `RunController`.

## Open Questions

None. All architectural decisions were resolved during brainstorming (Decisions D1–D5).
