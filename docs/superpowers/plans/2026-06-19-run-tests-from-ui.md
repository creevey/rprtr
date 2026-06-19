# Run Tests From UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the existing Start/Stop sidebar buttons to spawn `playwright test` as a child process via a new server-side `RunController`, reusing the existing reporter event flow.

**Architecture:** The server learns the user's `configFile` and `cwd` from the reporter's existing `register` message. A new `RunController` class spawns `playwright test --config <abs>` with optional `file:line` and `--project` filters from the registered `cwd`. The spawned process loads the user's `playwright.config` (which already lists `@crvy/rprtr`), the reporter reconnects over WebSocket, and the existing `test-begin`/`test-end`/`run-end` flow drives `reportData.isRunning`. The client wires its existing Start/Stop stubs to `POST /api/run` and `POST /api/stop`, and listens for a new `run-status` WebSocket message to stay in sync across browser tabs.

**Tech Stack:** TypeScript, Bun, Svelte 5, zod, ws, Node `child_process`.

**Spec:** `docs/superpowers/specs/2026-06-19-run-tests-from-ui-design.md`

---

## File Structure

**Create:**

- `src/server/run-controller.ts` — `RunController` class + types. Owns child-process lifecycle. Injectable deps for testing.
- `tests/run-controller.test.ts` — unit tests for `RunController` with fake spawn/broadcast.
- `tests/register-message.test.ts` — schema tests for the extended register payload.

**Modify:**

- `src/schemas.ts` — extend `RegisterDataSchema`; add `run-status` variant to `WebSocketMessageSchema`; add `RunRequestBodySchema`/`RunResponseSchema`/`StopResponseSchema`; surface `runEnabled` + `isRunning` on `ReportApiResponseSchema` and `ClientBootstrapDataSchema`.
- `src/types.ts` — add `run-status` variant to `ClientWebSocketMessage`; add `RunStatusData`.
- `src/reporter.ts` — extend `sendRegister` to include `configFile` + `cwd`.
- `src/server/handlers.ts` — extend `handleRegister` to persist `configFile`/`cwd` onto `routesContext`.
- `src/server/routes.ts` — extend `RoutesContext` with `runContext`; add `POST /api/run` + `POST /api/stop`; include `runEnabled` in `/api/report`.
- `src/server/app.ts` — instantiate `RunController`, wire deps, fix `ServerApp.close()` to dispose.
- `src/index.ts` — read `runEnabled`/`isRunning` from bootstrap, pass as props.
- `src/client/App.svelte` — implement `handleStart`/`handleStop`; accept `runEnabled`/`runMessage` props; handle `run-status` message.
- `src/client/components/Sidebar.svelte` — replace `{#if !isReport && !isUpdateMode}` with `{#if runEnabled}`; accept new props.
- `tests/server-handlers.test.ts` — cover `handleRegister` persistence of `configFile`/`cwd`.
- `tests/server-routes.test.ts` — cover `/api/run`, `/api/stop`, `runEnabled` in `/api/report`.

**One refinement to the spec (noted here so it is explicit):** the spec describes a synchronous `spawn-failed` 500 response on `ENOENT`. Node's `child_process.spawn` actually emits `'error'` asynchronously, so the controller treats any spawn `'error'` event as an immediate exit (set `isRunning=false`, broadcast `run-status:false`). The HTTP response from `/api/run` is therefore 200 whenever preconditions pass; spawn-time errors surface through the `run-status` broadcast. This is simpler, testable with the injected fake, and avoids unreliable synchronous PATH checks for `npx`. The `'spawn-failed'` reason is dropped from `RunResponseSchema`.

---

## Task 1: Extend schemas for register payload, run-status, run/stop request bodies, and bootstrap fields

**Files:**

- Modify: `src/schemas.ts`

- [ ] **Step 1: Extend `RegisterDataSchema` with `configFile` and `cwd`**

In `src/schemas.ts`, find the `RegisterDataSchema` block (around line 190) and add two optional string fields:

```ts
export const RegisterDataSchema = z.object({
  playwrightSnapshotDir: z.string().optional(),
  playwrightTestDir: z.string().optional(),
  playwrightSnapshotPathTemplate: z.string().optional(),
  playwrightToHaveScreenshotPathTemplate: z.string().optional(),
  configFile: z.string().optional(),
  cwd: z.string().optional(),
})
```

- [ ] **Step 2: Add `run-status` variant to `WebSocketMessageSchema`**

Find the `WebSocketMessageSchema` discriminated union (around line 133). Add a new variant before the closing `]`:

```ts
  z.object({
    type: z.literal('run-status'),
    data: z.object({
      running: z.boolean(),
    }),
  }),
```

- [ ] **Step 3: Add request/response schemas for run and stop**

Append these after the `ApproveRequestBodySchema` block:

```ts
export const RunRequestBodySchema = z.object({
  files: z.array(z.string()).optional(),
  project: z.string().optional(),
})

export type RunRequestBody = z.infer<typeof RunRequestBodySchema>

export const RunResponseSchema = z.union([
  z.object({ ok: z.literal(true) }),
  z.object({
    ok: z.literal(false),
    reason: z.enum(['no-config', 'already-running']),
  }),
])

export type RunResponse = z.infer<typeof RunResponseSchema>

export const StopResponseSchema = z.union([
  z.object({ ok: z.literal(true) }),
  z.object({
    ok: z.literal(false),
    reason: z.literal('not-running'),
  }),
])

export type StopResponse = z.infer<typeof StopResponseSchema>
```

- [ ] **Step 4: Surface `runEnabled` and `isRunning` on the API response + bootstrap schemas**

Find `ReportApiResponseSchema` (around line 247) and extend it:

```ts
export const ReportApiResponseSchema = z.object({
  tests: z.record(z.string(), TestDataSchema),
  isUpdateMode: z.boolean().optional(),
  isRunning: z.boolean().optional(),
  runEnabled: z.boolean().optional(),
})
```

Find `ClientBootstrapDataSchema` (around line 254) and extend it:

```ts
export const ClientBootstrapDataSchema = z.object({
  report: ReportApiResponseSchema.extend({
    isUpdateMode: z.boolean(),
  }),
  liveUpdates: z.boolean(),
  approvalEnabled: z.boolean(),
  approvalMessage: z.string().optional(),
  runEnabled: z.boolean().optional(),
  isRunning: z.boolean().optional(),
})
```

- [ ] **Step 5: Run typecheck and existing tests**

Run: `bun run typecheck`
Expected: PASS (no type errors; the new optional fields are additive).

Run: `cd tests && bun test *.test.ts`
Expected: all existing tests still PASS (schemas are backward-compatible).

- [ ] **Step 6: Commit**

```bash
git add src/schemas.ts
git commit -m "feat(schemas): add run-status, run/stop request bodies, register config fields"
```

---

## Task 2: Add `run-status` to client-side types

**Files:**

- Modify: `src/types.ts`

- [ ] **Step 1: Extend `ClientWebSocketMessage` with a `run-status` variant**

Find `ClientWebSocketMessage` (around line 92) and add the new variant:

```ts
export type ClientWebSocketMessage =
  | { type: 'test-begin'; data: TestData }
  | { type: 'test-update'; data: TestData }
  | { type: 'run-end'; data: WebSocketRunEndData }
  | { type: 'sync'; data: WebSocketSyncData }
  | { type: 'approve'; data: unknown }
  | { type: 'run-status'; data: { running: boolean } }
```

- [ ] **Step 2: Run typecheck**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/types.ts
git commit -m "feat(types): add run-status variant to ClientWebSocketMessage"
```

---

## Task 3: Extend reporter `sendRegister` with `configFile` + `cwd`

**Files:**

- Modify: `src/reporter.ts`
- Test: `tests/register-message.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/register-message.test.ts`:

```ts
import { describe, expect, test } from 'bun:test'

import { RegisterDataSchema, safeParse } from '../src/schemas'

describe('RegisterDataSchema', () => {
  test('parses a payload that includes configFile and cwd', () => {
    const payload = {
      playwrightSnapshotDir: '/proj/tests/__screenshots__',
      playwrightTestDir: '/proj/tests',
      configFile: '/proj/playwright.config.ts',
      cwd: '/proj',
    }
    expect(safeParse(RegisterDataSchema, payload)).toEqual(payload)
  })

  test('parses an old payload that omits configFile and cwd (backward compat)', () => {
    const payload = {
      playwrightSnapshotDir: '/proj/tests/__screenshots__',
      playwrightTestDir: '/proj/tests',
    }
    expect(safeParse(RegisterDataSchema, payload)).toEqual(payload)
  })

  test('parses an empty payload', () => {
    expect(safeParse(RegisterDataSchema, {})).toEqual({})
  })
})
```

- [ ] **Step 2: Run test to verify it passes (schema already extended in Task 1)**

Run: `cd tests && bun test register-message.test.ts`
Expected: PASS — Task 1 already added the fields, so this test validates the schema work.

- [ ] **Step 3: Extend `sendRegister` in `src/reporter.ts`**

Find `sendRegister` (around line 117). Replace it with:

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
      configFile: config.configFile,
      cwd: config.rootDir ?? process.cwd(),
    },
  })
}
```

- [ ] **Step 4: Run typecheck**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Run all unit tests**

Run: `cd tests && bun test *.test.ts`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add src/reporter.ts tests/register-message.test.ts
git commit -m "feat(reporter): include configFile and cwd in register message"
```

---

## Task 4: Implement `RunController` with injectable dependencies

**Files:**

- Create: `src/server/run-controller.ts`
- Test: `tests/run-controller.test.ts`

- [ ] **Step 1: Write the failing test file with all cases as `test.todo`**

Create `tests/run-controller.test.ts`. This step writes the test scaffolding (imports, helpers, `describe` blocks) so the next steps can fill in cases one at a time and watch them go green.

```ts
import { describe, expect, test } from 'bun:test'

import {
  RunController,
  type ChildProcessLike,
  type RunContext,
  type RunControllerDeps,
} from '../src/server/run-controller'
import type { ClientWebSocketMessage } from '../src/types'

interface StubChild {
  killed: string[]
  exitEmitters: Array<(code: number | null) => void>
  errorEmitters: Array<(err: Error) => void>
}

function createStubChild(): StubChild & ChildProcessLike {
  const exitEmitters: Array<(code: number | null) => void> = []
  const errorEmitters: Array<(err: Error) => void> = []
  const killed: string[] = []
  return {
    killed,
    exitEmitters,
    errorEmitters,
    on(event: 'exit' | 'error', cb: ((code: number | null) => void) | ((err: Error) => void)): void {
      if (event === 'exit') exitEmitters.push(cb as (code: number | null) => void)
      if (event === 'error') errorEmitters.push(cb as (err: Error) => void)
    },
    kill(sig: string): void {
      killed.push(sig)
    },
  }
}

interface Fixture {
  controller: RunController
  child: ReturnType<typeof createStubChild>
  broadcasts: ClientWebSocketMessage[]
  runningFlag: { value: boolean }
  spawnCalls: Array<{ cmd: string; args: string[]; opts: Record<string, unknown> }>
  advanceTimer: (ms: number) => void
  setRunContext: (ctx: RunContext | null) => void
}

function createFixture(initialCtx: RunContext | null = null): Fixture {
  let runCtx: RunContext | null = initialCtx
  const broadcasts: ClientWebSocketMessage[] = []
  const runningFlag = { value: false }
  const spawnCalls: Array<{ cmd: string; args: string[]; opts: Record<string, unknown> }> = []
  const pendingTimers: Array<{ fireAt: number; fn: () => void }> = []
  let now = 0
  const child = createStubChild()
  const deps: RunControllerDeps = {
    getRunContext: () => runCtx,
    port: 3000,
    broadcast: (msg) => broadcasts.push(msg),
    setReportRunning: (running) => {
      runningFlag.value = running
    },
    spawn: (cmd, args, opts) => {
      spawnCalls.push({ cmd, args, opts })
      return child
    },
    timers: {
      setTimeout: (fn, ms) => {
        const handle = { fireAt: now + (ms ?? 0), fn }
        pendingTimers.push(handle)
        return handle as unknown as ReturnType<typeof setTimeout>
      },
      clearTimeout: (handle) => {
        const i = pendingTimers.indexOf(handle as unknown as { fireAt: number; fn: () => void })
        if (i >= 0) pendingTimers.splice(i, 1)
      },
    },
  }
  const controller = new RunController(deps)
  return {
    controller,
    child,
    broadcasts,
    runningFlag,
    spawnCalls,
    advanceTimer: (ms) => {
      now += ms
      for (const t of pendingTimers.splice(0)) {
        if (t.fireAt <= now) t.fn()
      }
    },
    setRunContext: (ctx) => {
      runCtx = ctx
    },
  }
}

const SAMPLE_CTX: RunContext = { configFile: '/proj/playwright.config.ts', cwd: '/proj' }

describe('RunController.start', () => {
  test.todo('refuses when no config registered')
  test.todo('spawns with --config and cwd on happy path')
  test.todo('refuses when already running')
  test.todo('passes files as positional file:line args')
  test.todo('passes project as --project arg')
})

describe('RunController child exit', () => {
  test.todo('resets state on clean exit')
  test.todo('resets state on nonzero exit')
  test.todo('treats spawn error event as immediate exit')
})

describe('RunController.stop', () => {
  test.todo('refuses when not running')
  test.todo('sends SIGTERM on happy path')
  test.todo('escalates to SIGKILL after 5 seconds')
})

describe('RunController.dispose', () => {
  test.todo('SIGKILLs the current child immediately')
})
```

Run: `cd tests && bun test run-controller.test.ts`
Expected: compilation FAIL — `RunController` and its types do not exist yet.

- [ ] **Step 2: Create the minimal `RunController` module so the test file compiles**

Create `src/server/run-controller.ts`:

```ts
import type { ChildProcess } from 'child_process'

import type { ClientWebSocketMessage } from '../types.ts'

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
  | { ok: false; reason: 'no-config' | 'already-running' }

export type StopResult =
  | { ok: true }
  | { ok: false; reason: 'not-running' }

export interface ChildProcessLike {
  on(event: 'exit', cb: (code: number | null) => void): void
  on(event: 'error', cb: (err: Error) => void): void
  kill(signal: string): void
}

export interface SpawnLike {
  (cmd: string, args: string[], opts: Record<string, unknown>): ChildProcessLike
}

export interface RunControllerDeps {
  getRunContext(): RunContext | null
  port: number
  broadcast(message: ClientWebSocketMessage): void
  setReportRunning(running: boolean): void
  spawn: SpawnLike
  timers: {
    setTimeout: (fn: () => void, ms?: number) => unknown
    clearTimeout: (handle: unknown): void
  }
}

const STOP_GRACE_MS = 5000

function resolveBin(cwd: string): { cmd: string; argsPrefix: string[] } {
  return { cmd: 'npx', argsPrefix: ['playwright'] }
}

function toArgs(filters: RunFilters, configFile: string): string[] {
  const args = ['test', '--config', configFile]
  if (filters.project !== undefined) args.push('--project', filters.project)
  if (filters.files !== undefined) args.push(...filters.files)
  return args
}

export class RunController {
  private child: ChildProcessLike | null = null
  private sigkillTimer: unknown = null

  constructor(private readonly deps: RunControllerDeps) {}

  get isRunning(): boolean {
    return this.child !== null
  }

  start(filters: RunFilters): StartResult {
    const ctx = this.deps.getRunContext()
    if (ctx === null) return { ok: false, reason: 'no-config' }
    if (this.child !== null) return { ok: false, reason: 'already-running' }

    const { cmd, argsPrefix } = resolveBin(ctx.cwd)
    const args = [...argsPrefix, ...toArgs(filters, ctx.configFile)]
    const child = this.deps.spawn(cmd, args, {
      cwd: ctx.cwd,
      env: { ...process.env, CRVY_RPRTR_SERVER_URL: `ws://localhost:${this.deps.port}` },
      stdio: 'inherit',
    })
    this.child = child
    child.on('exit', (code) => this.handleChildExit(code))
    child.on('error', () => this.handleChildExit(null))
    this.deps.setReportRunning(true)
    this.deps.broadcast({ type: 'run-status', data: { running: true } })
    return { ok: true }
  }

  stop(): StopResult {
    if (this.child === null) return { ok: false, reason: 'not-running' }
    this.child.kill('SIGTERM')
    this.sigkillTimer = this.deps.timers.setTimeout(() => {
      if (this.child !== null) this.child.kill('SIGKILL')
    }, STOP_GRACE_MS)
    return { ok: true }
  }

  dispose(): void {
    if (this.child === null) return
    if (this.sigkillTimer !== null) this.deps.timers.clearTimeout(this.sigkillTimer)
    this.sigkillTimer = null
    this.child.kill('SIGKILL')
  }

  private handleChildExit(code: number | null): void {
    if (this.sigkillTimer !== null) {
      this.deps.timers.clearTimeout(this.sigkillTimer)
      this.sigkillTimer = null
    }
    this.child = null
    if (code !== null && code !== 0) {
      console.warn(`[RunController] playwright test exited with code ${code}`)
    }
    this.deps.setReportRunning(false)
    this.deps.broadcast({ type: 'run-status', data: { running: false } })
  }
}

export function createRealSpawn(): SpawnLike {
  const { spawn } = require('child_process') as typeof import('child_process')
  return (cmd, args, opts) => spawn(cmd, args, opts) as unknown as ChildProcessLike
}

export function createRealTimers(): RunControllerDeps['timers'] {
  return { setTimeout, clearTimeout }
}

export type { ChildProcess }
```

Run: `cd tests && bun test run-controller.test.ts`
Expected: PASS with all tests marked `todo` (Bun reports these as pending).

- [ ] **Step 3: Replace `test.todo` for "refuses when no config registered"**

In `tests/run-controller.test.ts`, find the first `test.todo('refuses when no config registered')` under `RunController.start` and replace it with:

```ts
test('refuses when no config registered', () => {
  const f = createFixture(null)
  const result = f.controller.start({})
  expect(result).toEqual({ ok: false, reason: 'no-config' })
  expect(f.spawnCalls).toHaveLength(0)
  expect(f.broadcasts).toHaveLength(0)
  expect(f.runningFlag.value).toBe(false)
})
```

Run: `cd tests && bun test run-controller.test.ts`
Expected: PASS.

- [ ] **Step 4: Replace `test.todo` for "spawns with --config and cwd on happy path"**

```ts
test('spawns with --config and cwd on happy path', () => {
  const f = createFixture(SAMPLE_CTX)
  const result = f.controller.start({})
  expect(result).toEqual({ ok: true })
  expect(f.spawnCalls).toHaveLength(1)
  const { cmd, args, opts } = f.spawnCalls[0]!
  expect(cmd).toBe('npx')
  expect(args).toEqual(['playwright', 'test', '--config', '/proj/playwright.config.ts'])
  expect(opts.cwd).toBe('/proj')
  expect((opts.env as Record<string, string>).CRVY_RPRTR_SERVER_URL).toBe('ws://localhost:3000')
  expect(f.runningFlag.value).toBe(true)
  expect(f.broadcasts).toEqual([{ type: 'run-status', data: { running: true } }])
  expect(f.controller.isRunning).toBe(true)
})
```

Run: `cd tests && bun test run-controller.test.ts`
Expected: PASS.

- [ ] **Step 5: Replace `test.todo` for "refuses when already running"**

```ts
test('refuses when already running', () => {
  const f = createFixture(SAMPLE_CTX)
  f.controller.start({})
  const second = f.controller.start({})
  expect(second).toEqual({ ok: false, reason: 'already-running' })
  expect(f.spawnCalls).toHaveLength(1)
})
```

Run: `cd tests && bun test run-controller.test.ts`
Expected: PASS.

- [ ] **Step 6: Replace `test.todo` for "passes files as positional file:line args"**

```ts
test('passes files as positional file:line args', () => {
  const f = createFixture(SAMPLE_CTX)
  f.controller.start({ files: ['tests/foo.spec.ts:42'] })
  expect(f.spawnCalls[0]!.args).toEqual([
    'playwright',
    'test',
    '--config',
    '/proj/playwright.config.ts',
    'tests/foo.spec.ts:42',
  ])
})
```

Run: `cd tests && bun test run-controller.test.ts`
Expected: PASS.

- [ ] **Step 7: Replace `test.todo` for "passes project as --project arg"**

```ts
test('passes project as --project arg', () => {
  const f = createFixture(SAMPLE_CTX)
  f.controller.start({ project: 'chromium' })
  expect(f.spawnCalls[0]!.args).toEqual([
    'playwright',
    'test',
    '--config',
    '/proj/playwright.config.ts',
    '--project',
    'chromium',
  ])
})
```

Run: `cd tests && bun test run-controller.test.ts`
Expected: PASS.

- [ ] **Step 8: Replace `test.todo` for "resets state on clean exit"**

```ts
test('resets state on clean exit', () => {
  const f = createFixture(SAMPLE_CTX)
  f.controller.start({})
  f.child.exitEmitters.forEach((cb) => cb(0))
  expect(f.runningFlag.value).toBe(false)
  expect(f.broadcasts).toEqual([
    { type: 'run-status', data: { running: true } },
    { type: 'run-status', data: { running: false } },
  ])
  expect(f.controller.isRunning).toBe(false)
})
```

Run: `cd tests && bun test run-controller.test.ts`
Expected: PASS.

- [ ] **Step 9: Replace `test.todo` for "resets state on nonzero exit"**

```ts
test('resets state on nonzero exit', () => {
  const f = createFixture(SAMPLE_CTX)
  f.controller.start({})
  f.child.exitEmitters.forEach((cb) => cb(1))
  expect(f.runningFlag.value).toBe(false)
  expect(f.controller.isRunning).toBe(false)
})
```

Run: `cd tests && bun test run-controller.test.ts`
Expected: PASS.

- [ ] **Step 10: Replace `test.todo` for "treats spawn error event as immediate exit"**

```ts
test('treats spawn error event as immediate exit', () => {
  const f = createFixture(SAMPLE_CTX)
  f.controller.start({})
  f.child.errorEmitters.forEach((cb) => cb(new Error('ENOENT')))
  expect(f.runningFlag.value).toBe(false)
  expect(f.controller.isRunning).toBe(false)
  expect(f.broadcasts).toContainEqual({ type: 'run-status', data: { running: false } })
})
```

Run: `cd tests && bun test run-controller.test.ts`
Expected: PASS.

- [ ] **Step 11: Replace `test.todo` for "refuses when not running"**

```ts
test('refuses when not running', () => {
  const f = createFixture(SAMPLE_CTX)
  expect(f.controller.stop()).toEqual({ ok: false, reason: 'not-running' })
})
```

Run: `cd tests && bun test run-controller.test.ts`
Expected: PASS.

- [ ] **Step 12: Replace `test.todo` for "sends SIGTERM on happy path"**

```ts
test('sends SIGTERM on happy path', () => {
  const f = createFixture(SAMPLE_CTX)
  f.controller.start({})
  expect(f.controller.stop()).toEqual({ ok: true })
  expect(f.child.killed).toEqual(['SIGTERM'])
  f.child.exitEmitters.forEach((cb) => cb(0))
  expect(f.child.killed).toEqual(['SIGTERM'])
})
```

Run: `cd tests && bun test run-controller.test.ts`
Expected: PASS.

- [ ] **Step 13: Replace `test.todo` for "escalates to SIGKILL after 5 seconds"**

```ts
test('escalates to SIGKILL after 5 seconds', () => {
  const f = createFixture(SAMPLE_CTX)
  f.controller.start({})
  f.controller.stop()
  expect(f.child.killed).toEqual(['SIGTERM'])
  f.advanceTimer(4999)
  expect(f.child.killed).toEqual(['SIGTERM'])
  f.advanceTimer(2)
  expect(f.child.killed).toEqual(['SIGTERM', 'SIGKILL'])
})
```

Run: `cd tests && bun test run-controller.test.ts`
Expected: PASS.

- [ ] **Step 14: Replace `test.todo` for "SIGKILLs the current child immediately"**

```ts
test('SIGKILLs the current child immediately', () => {
  const f = createFixture(SAMPLE_CTX)
  f.controller.start({})
  f.controller.dispose()
  expect(f.child.killed).toEqual(['SIGKILL'])
})
```

Run: `cd tests && bun test run-controller.test.ts`
Expected: PASS.

- [ ] **Step 15: Run all unit tests**

Run: `cd tests && bun test *.test.ts`
Expected: all PASS.

- [ ] **Step 16: Run typecheck and lint**

Run: `bun run typecheck && bun run lint`
Expected: PASS.

- [ ] **Step 17: Commit**

```bash
git add src/server/run-controller.ts tests/run-controller.test.ts
git commit -m "feat(server): add RunController for spawning playwright test"
```

---

## Task 5: Extend `RoutesContext` and `handleRegister` to persist `runContext`

**Files:**

- Modify: `src/server/routes.ts`
- Modify: `src/server/handlers.ts`
- Test: `tests/server-handlers.test.ts`

- [ ] **Step 1: Add `runContext` to `RoutesContext`**

In `src/server/routes.ts`, find the `RoutesContext` interface (around line 8) and add a new field:

```ts
export interface RoutesContext {
  reportData: {
    isRunning: boolean
    tests: Record<string, TestData>
    browsers: string[]
    isUpdateMode: boolean
    screenshotDir: string
  }
  staticDir: string
  saveReport: () => Promise<void>
  artifactRoots?: string[]
  approvalRouting?: {
    configDir: string
    playwrightTestDir?: string
    playwrightSnapshotDir?: string
    playwrightSnapshotPathTemplate?: string
    playwrightToHaveScreenshotPathTemplate?: string
  }
  runContext?: { configFile: string; cwd: string }
}
```

- [ ] **Step 2: Extend `handleRegister` to persist `configFile` and `cwd`**

In `src/server/handlers.ts`, find `handleRegister` (around line 109). After the existing `approvalRouting` mutation block (around line 140), add:

```ts
if (data.configFile !== undefined && data.cwd !== undefined) {
  ctx.routesContext.runContext = { configFile: data.configFile, cwd: data.cwd }
}
```

The surrounding `handleRegister` body should now end like:

```ts
  if (ctx.routesContext.approvalRouting !== undefined) {
    if (data.playwrightSnapshotDir !== undefined) {
      ctx.routesContext.approvalRouting.playwrightSnapshotDir = data.playwrightSnapshotDir
    }
    // ... existing branches ...
  }

  if (data.configFile !== undefined && data.cwd !== undefined) {
    ctx.routesContext.runContext = { configFile: data.configFile, cwd: data.cwd }
  }

  console.log('[Server] Reporter registered with config:', {
    playwrightSnapshotDir: data.playwrightSnapshotDir,
    playwrightTestDir: data.playwrightTestDir,
  })
}
```

- [ ] **Step 3: Write the failing test in `tests/server-handlers.test.ts`**

Append a new `describe` block at the end of `tests/server-handlers.test.ts`:

```ts
describe('handleRegister runContext persistence', () => {
  let clients: Set<MockWebSocket>
  let ctx: HandlerContext

  beforeEach(() => {
    const created = createContext()
    ctx = created.ctx
    clients = created.clients
  })

  test('persists configFile and cwd onto routesContext', () => {
    handleRegister(ctx, {
      configFile: '/proj/playwright.config.ts',
      cwd: '/proj',
    })
    expect(ctx.routesContext.runContext).toEqual({
      configFile: '/proj/playwright.config.ts',
      cwd: '/proj',
    })
  })

  test('does not overwrite runContext when payload omits the fields', () => {
    ctx.routesContext.runContext = { configFile: '/existing.ts', cwd: '/existing' }
    handleRegister(ctx, { playwrightSnapshotDir: '/snapshots' })
    expect(ctx.routesContext.runContext).toEqual({ configFile: '/existing.ts', cwd: '/existing' })
  })

  test('does not set runContext when only one of configFile/cwd is present', () => {
    handleRegister(ctx, { configFile: '/proj/playwright.config.ts' })
    expect(ctx.routesContext.runContext).toBeUndefined()
  })
})
```

Make sure `handleRegister` is added to the import list at the top of the file:

```ts
import {
  handleRunEnd,
  handleSync,
  handleTestBegin,
  handleTestEnd,
  handleRegister,
  type HandlerContext,
} from '../src/server/handlers'
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd tests && bun test server-handlers.test.ts`
Expected: PASS.

- [ ] **Step 5: Run typecheck and lint**

Run: `bun run typecheck && bun run lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/server/routes.ts src/server/handlers.ts tests/server-handlers.test.ts
git commit -m "feat(server): persist register payload configFile and cwd as runContext"
```

---

## Task 6: Instantiate `RunController` in `createServerApp` and fix `ServerApp.close()`

**Files:**

- Modify: `src/server/app.ts`

- [ ] **Step 1: Wire the `RunController`**

In `src/server/app.ts`, add the import at the top:

```ts
import { RunController, createRealSpawn, createRealTimers, type RunContext } from './run-controller.ts'
```

Find the `createRoutesContext` function (around line 238). Add `runContext` to the returned object so the routes layer can read it and the run controller can write to it via `handleRegister`. The existing function body returns the context object literal — add `runContext: undefined` to it:

```ts
function createRoutesContext(
  reportData: ReportData,
  staticDir: string,
  saveReport: () => Promise<void>,
  options: ServerOptions,
): RoutesContext {
  const artifactRoots = [reportData.screenshotDir, options.outputDir, options.playwrightSnapshotDir].filter(
    (root): root is string => root !== undefined && root !== '',
  )

  return {
    reportData,
    staticDir,
    saveReport,
    artifactRoots,
    approvalRouting: {
      configDir: options.configDir ?? process.cwd(),
      playwrightTestDir: options.playwrightTestDir,
      playwrightSnapshotDir: options.playwrightSnapshotDir,
      playwrightSnapshotPathTemplate: options.playwrightSnapshotPathTemplate,
      playwrightToHaveScreenshotPathTemplate: options.playwrightToHaveScreenshotPathTemplate,
    },
    runContext: undefined,
  }
}
```

In `createServerApp` (around line 265), instantiate the `RunController` after `routesContext` is created and before `getHandlerContext`. Replace the existing return path with code that also instantiates the controller and uses it in the returned `close`:

```ts
export async function createServerApp(options: ServerOptions = {}): Promise<ServerApp> {
  const port = options.port ?? 3000
  const reportData = createReportData(options)
  const reportPathOption = options.reportPath ?? './report.json'
  const { reportFile, offlineReportDir } = await resolveReportPath(reportPathOption)
  const staticDir = await resolveStaticDir(options.staticDir)
  const wsClients = new Set<RuntimeWebSocket>()
  const currentRunIds = new Set<string>()

  async function saveReport(): Promise<void> {
    await writeJsonFile(reportFile, reportData)
  }

  const routesContext = createRoutesContext(reportData, staticDir, saveReport, options)

  const runController = new RunController({
    getRunContext: (): RunContext | null => routesContext.runContext ?? null,
    port,
    broadcast: (message) => broadcastToBrowsers(wsClients, message),
    setReportRunning: (running) => {
      reportData.isRunning = running
    },
    spawn: createRealSpawn(),
    timers: createRealTimers(),
  })

  const getHandlerContext = (): HandlerContext => ({
    reportData,
    wsClients,
    currentRunIds,
    saveReport,
    approvalRouting: routesContext.approvalRouting,
    routesContext,
    runController,
  })
  const handleRequest = (req: Request): Promise<Response> => handleHttpRequest(routesContext, req, runController)
  const handleWebSocketMessage = createWebSocketMessageHandler(getHandlerContext)

  await loadReport(reportFile, reportData)
  await loadOfflineReports(offlineReportDir, reportData)

  return {
    port,
    wsClients,
    close: () => {
      runController.dispose()
    },
    handleRequest,
    handleWebSocketMessage,
  }
}
```

Add `broadcastToBrowsers` to the existing utils import at the top of `app.ts` if it is not already imported (it is exported from `./utils.ts`):

```ts
import { broadcastToBrowsers } from './utils.ts'
```

- [ ] **Step 2: Update `HandlerContext` to carry `runController`**

In `src/server/handlers.ts`, add `runController` to the `HandlerContext` interface:

```ts
import type { RunController } from './run-controller.ts'

export interface HandlerContext {
  reportData: {
    isRunning: boolean
    tests: Record<string, TestData>
    browsers: string[]
    isUpdateMode: boolean
    screenshotDir: string
  }
  wsClients: Set<RuntimeWebSocket>
  currentRunIds: Set<string>
  saveReport: () => Promise<void>
  approvalRouting?: ApprovalRouting
  routesContext: RoutesContext
  runController: RunController
}
```

The handlers themselves do not call `runController` (the HTTP routes do), but it is threaded through so future reporter-driven actions can use it without changing the context shape again. Existing handler tests in `tests/server-handlers.test.ts` construct a `HandlerContext` literal — update them in Step 4 to include `runController: null as never` (the handlers under test do not touch it).

- [ ] **Step 3: Update `handleHttpRequest` signature in `src/server/routes.ts`**

Change the signature of `handleHttpRequest` to accept the `RunController` and thread it into the new `/api/run` and `/api/stop` routes (added in Task 7):

```ts
import type { RunController } from './run-controller.ts'

export function handleHttpRequest(ctx: RoutesContext, req: Request, runController: RunController): Promise<Response> {
  // ... existing body ...
}
```

For now, the body remains unchanged; the new routes are added in Task 7. The compile-time check is that every caller now passes a `RunController`.

- [ ] **Step 4: Update existing `HandlerContext`-literal tests**

In `tests/server-handlers.test.ts`, the `createContext` helper builds a `HandlerContext`. Add a `runController` field. Since handlers under test do not touch it, a typed placeholder is fine:

```ts
function createContext(): { ctx: HandlerContext; clients: Set<MockWebSocket> } {
  const clients = new Set<MockWebSocket>()
  const state = createMutableReportState('./screenshots')
  const ctx: HandlerContext = {
    reportData: state.reportData,
    wsClients: clients as unknown as Set<RuntimeWebSocket>,
    currentRunIds: state.currentRunIds,
    saveReport: async (): Promise<void> => {},
    routesContext: {
      reportData: state.reportData,
      staticDir: './dist',
      saveReport: async (): Promise<void> => {},
    },
    runController: null as unknown as HandlerContext['runController'],
  }
  return { ctx, clients }
}
```

- [ ] **Step 5: Run typecheck**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 6: Run all unit tests**

Run: `cd tests && bun test *.test.ts`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add src/server/app.ts src/server/handlers.ts src/server/routes.ts tests/server-handlers.test.ts
git commit -m "feat(server): instantiate RunController in createServerApp and dispose on close"
```

---

## Task 7: Add `POST /api/run`, `POST /api/stop`, and `runEnabled` in `/api/report`

**Files:**

- Modify: `src/server/routes.ts`
- Test: `tests/server-routes.test.ts`

- [ ] **Step 1: Add `runEnabled` to the `/api/report` response**

In `src/server/routes.ts`, find `handleApiReport` (around line 53). It returns `Response.json(ctx.reportData)`. The `RoutesContext.reportData` does not carry `runEnabled`, so derive it from `ctx.runContext`:

```ts
function handleApiReport(ctx: RoutesContext): Response {
  return Response.json({
    ...ctx.reportData,
    runEnabled: ctx.runContext !== undefined,
  })
}
```

- [ ] **Step 2: Add `handleApiRun` and `handleApiStop`**

Append two new handler functions near the existing `handleApiApproveAll` (around line 187):

```ts
async function handleApiRun(runController: RunController, req: Request): Promise<Response> {
  let body: unknown = {}
  try {
    body = await req.json()
  } catch {
    // Empty body is allowed; default to {}.
  }
  const parsed = safeParse(RunRequestBodySchema, body)
  if (parsed === null) {
    return Response.json({ ok: false, reason: 'no-config' }, { status: 400 })
  }
  const result = runController.start(parsed)
  if (result.ok) return Response.json(result)
  return Response.json(result, { status: 409 })
}

function handleApiStop(runController: RunController): Response {
  const result = runController.stop()
  if (result.ok) return Response.json(result)
  return Response.json(result, { status: 409 })
}
```

Add the schema import at the top of the file:

```ts
import { ApproveRequestBodySchema, RunRequestBodySchema, safeParse } from '../schemas.ts'
```

- [ ] **Step 3: Wire the new routes in `handleHttpRequest`**

Find the `handleHttpRequest` function. After the existing `/api/approve-all` branch (around line 248), add:

```ts
if (pathname === '/api/run' && req.method === 'POST') {
  return handleApiRun(runController, req)
}

if (pathname === '/api/stop' && req.method === 'POST') {
  return Promise.resolve(handleApiStop(runController))
}
```

- [ ] **Step 4: Write failing tests in `tests/server-routes.test.ts`**

Add a new `describe` block at the end of the file. Use a stub `RunController`-shaped object since the route only calls `.start()` and `.stop()`:

```ts
import type { RunController } from '../src/server/run-controller'

function createStubRunController(
  startResult: { ok: true } | { ok: false; reason: 'no-config' | 'already-running' },
  stopResult: { ok: true } | { ok: false; reason: 'not-running' } = { ok: true },
): RunController {
  return {
    start: () => startResult,
    stop: () => stopResult,
    dispose: () => {},
    isRunning: false,
  } as unknown as RunController
}

describe('run endpoints', () => {
  test('POST /api/run returns 200 on accepted start', async () => {
    const ctx = createContext({})
    const stub = createStubRunController({ ok: true })
    const res = await handleHttpRequest(
      ctx,
      new Request('http://localhost/api/run', { method: 'POST', body: '{}' }),
      stub,
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  test('POST /api/run returns 409 with reason when refused', async () => {
    const ctx = createContext({})
    const stub = createStubRunController({ ok: false, reason: 'already-running' })
    const res = await handleHttpRequest(
      ctx,
      new Request('http://localhost/api/run', { method: 'POST', body: '{}' }),
      stub,
    )
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ ok: false, reason: 'already-running' })
  })

  test('POST /api/run passes parsed files and project through', async () => {
    const ctx = createContext({})
    let captured: unknown = null
    const stub = {
      start: (filters: unknown) => {
        captured = filters
        return { ok: true }
      },
      stop: () => ({ ok: true }),
      dispose: () => {},
      isRunning: false,
    } as unknown as RunController
    await handleHttpRequest(
      ctx,
      new Request('http://localhost/api/run', {
        method: 'POST',
        body: JSON.stringify({ files: ['a.spec.ts:10'], project: 'chromium' }),
      }),
      stub,
    )
    expect(captured).toEqual({ files: ['a.spec.ts:10'], project: 'chromium' })
  })

  test('POST /api/stop returns 200 on accepted stop', async () => {
    const ctx = createContext({})
    const stub = createStubRunController({ ok: true }, { ok: true })
    const res = await handleHttpRequest(ctx, new Request('http://localhost/api/stop', { method: 'POST' }), stub)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  test('POST /api/stop returns 409 when not running', async () => {
    const ctx = createContext({})
    const stub = createStubRunController({ ok: true }, { ok: false, reason: 'not-running' })
    const res = await handleHttpRequest(ctx, new Request('http://localhost/api/stop', { method: 'POST' }), stub)
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ ok: false, reason: 'not-running' })
  })

  test('GET /api/report includes runEnabled=false when no runContext set', async () => {
    const ctx = createContext({})
    const stub = createStubRunController({ ok: true })
    const res = await handleHttpRequest(ctx, new Request('http://localhost/api/report'), stub)
    const body = await res.json()
    expect(body.runEnabled).toBe(false)
  })

  test('GET /api/report includes runEnabled=true when runContext is set', async () => {
    const ctx = createContext({})
    ctx.runContext = { configFile: '/proj/playwright.config.ts', cwd: '/proj' }
    const stub = createStubRunController({ ok: true })
    const res = await handleHttpRequest(ctx, new Request('http://localhost/api/report'), stub)
    const body = await res.json()
    expect(body.runEnabled).toBe(true)
  })
})
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd tests && bun test server-routes.test.ts`
Expected: PASS.

- [ ] **Step 6: Update existing `handleHttpRequest` callers in tests**

The existing `handleHttpRequest` callers in `tests/server-routes.test.ts` (outside the new `describe` block) need the third argument. Search the file for `handleHttpRequest(` calls and append `, createStubRunController({ ok: true })` to each. The existing approval tests do not assert on run endpoints, so a default-returning stub is fine.

Run: `cd tests && bun test server-routes.test.ts`
Expected: PASS (all approval tests still green).

- [ ] **Step 7: Run typecheck, lint, and full unit suite**

Run: `bun run typecheck && bun run lint && (cd tests && bun test *.test.ts)`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/server/routes.ts tests/server-routes.test.ts
git commit -m "feat(server): add POST /api/run and /api/stop, surface runEnabled in /api/report"
```

---

## Task 8: Wire `runEnabled`/`isRunning` through `src/index.ts` bootstrap

**Files:**

- Modify: `src/index.ts`

- [ ] **Step 1: Extend `InitialState` and pass new props to `App`**

In `src/index.ts`, extend `InitialState`:

```ts
interface InitialState {
  tests: CrvyRprtrSuite
  isReport: boolean
  isUpdateMode: boolean
  liveUpdates: boolean
  approvalEnabled: boolean
  approvalMessage?: string
  runEnabled: boolean
  isRunning: boolean
}
```

Update `loadBootstrapData` return:

```ts
return {
  tests: treeifyTests(parsed.report.tests),
  isReport: true,
  isUpdateMode: parsed.report.isUpdateMode,
  liveUpdates: parsed.liveUpdates,
  approvalEnabled: parsed.approvalEnabled,
  approvalMessage: parsed.approvalMessage,
  runEnabled: parsed.runEnabled ?? false,
  isRunning: parsed.report.isRunning ?? false,
}
```

Update `loadReportData` return:

```ts
return {
  tests: treeifyTests(parsed.tests),
  isReport: true,
  isUpdateMode: parsed.isUpdateMode ?? false,
  liveUpdates: true,
  approvalEnabled: true,
  runEnabled: parsed.runEnabled ?? false,
  isRunning: parsed.isRunning ?? false,
}
```

Update the `mount(App, ...)` call to pass the new props:

```ts
mount(App, {
  target: root,
  props: {
    initialTests: initialState.tests,
    isReport: initialState.isReport,
    isUpdateMode: initialState.isUpdateMode,
    liveUpdates: initialState.liveUpdates,
    approvalEnabled: initialState.approvalEnabled,
    approvalMessage: initialState.approvalMessage,
    runEnabled: initialState.runEnabled,
    isRunning: initialState.isRunning,
    onApprove: handleApprove,
    onApproveAll: handleApproveAll,
  },
})
```

- [ ] **Step 2: Run typecheck**

Run: `bun run typecheck`
Expected: PASS once Task 9 also lands (App.svelte now expects these props). For this isolated step, typecheck of `src/index.ts` alone may fail because `App.props` has not yet been updated. To keep commits atomic, stage Tasks 8 and 9 together in the next commit if a green typecheck is required at this exact step — otherwise defer the typecheck run until Task 9 Step 2.

- [ ] **Step 3: (Defer commit until Task 9 lands; or commit together with Task 9.)**

---

## Task 9: Wire the client `App.svelte` handlers, props, and `run-status` listener

**Files:**

- Modify: `src/client/App.svelte`

- [ ] **Step 1: Add the new props and `runMessage` state**

In `src/client/App.svelte`, extend the `Props` interface and destructure:

```ts
interface Props {
  initialTests: CrvyRprtrSuite
  isReport: boolean
  isUpdateMode: boolean
  liveUpdates: boolean
  approvalEnabled: boolean
  approvalMessage?: string
  runEnabled: boolean
  isRunning: boolean
  onApprove: (id: string, retry: number, image: string) => Promise<ApprovalResult>
  onApproveAll: () => Promise<BulkApprovalResult>
}

let {
  initialTests,
  isReport,
  isUpdateMode,
  liveUpdates,
  approvalEnabled,
  approvalMessage,
  runEnabled,
  isRunning: initialIsRunning,
  onApprove,
  onApproveAll,
}: Props = $props()
```

Replace the existing `let isRunning = $state(false)` with:

```ts
let isRunning = $state(initialIsRunning)
let runMessage = $state<string | null>(null)
```

- [ ] **Step 2: Replace the empty `handleStart` and `handleStop` stubs**

Find the stubs (around line 279) and replace:

```ts
async function handleStart(): Promise<void> {
  const res = await fetch('/api/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })
  if (res.status === 409) {
    const body = (await res.json().catch(() => null)) as { reason?: string } | null
    runMessage =
      body?.reason === 'already-running'
        ? 'A run is already in progress'
        : 'Connect a Playwright reporter to enable running'
  }
}

async function handleStop(): Promise<void> {
  await fetch('/api/stop', { method: 'POST' })
}
```

- [ ] **Step 3: Handle the new `run-status` message in the WebSocket `$effect`**

Find the `applyClientMessage` switch (around line 324). Add a new case before the closing `}`:

```ts
        case 'run-status': {
          isRunning = msg.data.running
          runMessage = null
          break
        }
```

- [ ] **Step 4: Pass the new props to `Sidebar`**

Find the `<Sidebar ... />` invocation (around line 363) and add `runEnabled`, `runMessage`:

```svelte
  <Sidebar
    {tests}
    selectedId={openedTest?.id}
    {focusedPath}
    {isReport}
    {isRunning}
    {isUpdateMode}
    {approvalEnabled}
    {approvalMessage}
    {runEnabled}
    {runMessage}
    {filter}
    {canApprove}
    onFilterChange={(f) => filter = f}
    onSelect={handleOpenTest}
    onOpen={handleSuiteOpen}
    onToggle={handleSuiteToggle}
    onStart={handleStart}
    onStop={handleStop}
    onApprove={handleApproveAndGoNext}
    onNext={handleGoToNextFailed}
    onApproveAll={handleApproveAllTests}
  />
```

- [ ] **Step 5: Run typecheck**

Run: `bun run typecheck`
Expected: PASS (the Sidebar prop update lands in Task 10; if typecheck fails here on `<Sidebar>` because the prop does not yet exist, defer the typecheck run until Task 10 Step 2 — or commit Tasks 9 and 10 together).

- [ ] **Step 6: (Defer commit until Task 10 lands.)**

---

## Task 10: Update `Sidebar.svelte` gate and props

**Files:**

- Modify: `src/client/components/Sidebar.svelte`

- [ ] **Step 1: Add `runEnabled` and `runMessage` to `Props`**

In `src/client/components/Sidebar.svelte`, extend the `Props` interface and destructure:

```ts
interface Props {
  tests: CrvyRprtrSuite
  selectedId?: string
  focusedPath: string[] | null
  isReport: boolean
  isRunning: boolean
  isUpdateMode: boolean
  approvalEnabled: boolean
  approvalMessage?: string
  runEnabled: boolean
  runMessage?: string | null
  filter: CrvyRprtrViewFilter
  canApprove: boolean
  onFilterChange: (filter: CrvyRprtrViewFilter) => void
  onSelect: (test: CrvyRprtrTest) => void
  onOpen: (path: string[], opened: boolean) => void
  onToggle: (path: string[], checked: boolean) => void
  onStart: () => void
  onStop: () => void
  onApprove: () => void
  onNext: () => void
  onApproveAll: () => void
}

let {
  tests,
  selectedId,
  focusedPath,
  isReport,
  isRunning,
  isUpdateMode,
  approvalEnabled,
  approvalMessage,
  runEnabled,
  runMessage,
  filter,
  canApprove,
  onFilterChange,
  onSelect,
  onOpen,
  onToggle,
  onStart,
  onStop,
  onApprove,
  onNext,
  onApproveAll,
}: Props = $props()
```

- [ ] **Step 2: Replace the dead gate with `{#if runEnabled}`**

Find the gate around line 120:

```svelte
      {#if !isReport && !isUpdateMode}
        <div class="mt-1">
          {#if isRunning}
            <button
              class="size-9 flex items-center justify-center bg-surface-input border border-edge rounded text-error cursor-pointer text-sm transition-colors hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-accent"
              aria-label="Stop tests"
              onclick={onStop}
            >&#9632;</button>
          {:else}
            <button
              class="size-9 flex items-center justify-center bg-surface-input border border-edge rounded text-success cursor-pointer text-sm transition-colors hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-accent"
              aria-label="Start tests"
              onclick={onStart}
            >&#9654;</button>
          {/if}
        </div>
      {/if}
```

Replace `{#if !isReport && !isUpdateMode}` with `{#if runEnabled}`. The button bodies stay identical.

- [ ] **Step 3: Render `runMessage` under the header when set**

Find the `{#if !approvalEnabled && approvalMessage}` block near the footer (around line 196). Add a sibling for run messages above the tree container, immediately after the header `<div class="p-4 border-b border-edge bg-surface-alt shrink-0">` closes. A minimal addition right after the filter `<input>` inside the header:

```svelte
    {#if runMessage}
      <div class="mt-2 text-center text-xs text-fg-muted">{runMessage}</div>
    {/if}
```

- [ ] **Step 4: Run typecheck and lint**

Run: `bun run typecheck && bun run lint`
Expected: PASS.

- [ ] **Step 5: Run the build**

Run: `bun run build`
Expected: PASS (svelte compiles, dist written).

- [ ] **Step 6: Commit Tasks 8, 9, 10 together**

```bash
git add src/index.ts src/client/App.svelte src/client/components/Sidebar.svelte
git commit -m "feat(client): wire Start/Stop buttons to /api/run and /api/stop"
```

---

## Task 11: Verify end-to-end via the full check pipeline

**Files:** none (verification only)

- [ ] **Step 1: Run the project's full check pipeline**

Run: `bun run check`
Expected: PASS (build + lint + typecheck + tests).

- [ ] **Step 2: Run the Playwright self-test**

Run: `bun run test:playwright`
Expected: PASS (the project dogfoods its own reporter; this verifies the reporter change in Task 3 still serializes a valid `register` payload).

- [ ] **Step 3: Manual smoke (optional but recommended)**

In one terminal:

```bash
bun run start
```

In another, from a project that uses `@crvy/rprtr` as a Playwright reporter:

```bash
npx playwright test
```

Open http://localhost:3000. Expected:

- The Start button (▶) appears in the sidebar header once the reporter connects (because `register` carries `configFile` + `cwd`).
- Clicking ▶ spawns `playwright test` (visible in the server terminal output).
- Test events flow and the UI updates live; baselines remain approve-able.
- Clicking ■ stops the spawned process within ~5 seconds.

- [ ] **Step 4: Commit any formatting fixes if `bun run check` rewrites files**

```bash
git add -u
git commit -m "chore: apply formatter to run-from-UI changes" --allow-empty
```

(Skip if there is nothing to commit.)

---

## Self-Review

**Spec coverage:**

- _Architecture & data flow_ — Tasks 4, 6, 7, 9.
- _Server components / RunController_ — Task 4.
- _Reporter `sendRegister` extension_ — Task 3.
- _Schema changes_ — Task 1.
- _Handler `handleRegister` persistence_ — Task 5.
- _`createServerApp` wiring + `close()` dispose_ — Task 6.
- _HTTP routes `/api/run`, `/api/stop`, `runEnabled` in `/api/report`_ — Task 7.
- _Client types_ — Task 2.
- _`src/index.ts` bootstrap propagation_ — Task 8.
- _`App.svelte` handlers, props, `run-status` listener_ — Task 9.
- _`Sidebar.svelte` gate fix and new props_ — Task 10.
- _State, concurrency, error handling_ — covered by Task 4 test cases (already-running, not-running, child exit, spawn error, SIGKILL grace).
- _Testing strategy_ — Tasks 3, 4, 5, 7.
- _Spec refinement on `spawn-failed`_ — noted at the top of the plan; Task 1 drops `'spawn-failed'` from `RunResponseSchema` accordingly.

**Type consistency:**

- `RunContext`, `RunFilters`, `StartResult`, `StopResult`, `ChildProcessLike`, `SpawnLike`, `RunControllerDeps` are defined once in Task 4 and used consistently in Tasks 5–7.
- `runContext` is the field name on `RoutesContext` (Tasks 5, 6, 7) and matches the getter in `getRunContext` (Task 6).
- `runEnabled` is the field name in `ReportApiResponseSchema`/`ClientBootstrapDataSchema` (Task 1), the `/api/report` handler (Task 7), the bootstrap propagation (Task 8), the `App.Props` (Task 9), and the `Sidebar.Props` (Task 10).
- `run-status` is the WebSocket message type (Tasks 1, 2, 9).
- `runMessage` is the local state in `App.svelte` and the `Sidebar` prop (Tasks 9, 10).

**Placeholder scan:** none — every step has the actual code or command.

**Scope check:** single feature, single plan, ships working software at every commit.
