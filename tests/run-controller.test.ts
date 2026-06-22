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

function createFixture(
  initialCtx: RunContext | null = null,
  resolveReporter?: (cwd: string) => string | null,
): Fixture {
  let runCtx: RunContext | null = initialCtx
  const broadcasts: ClientWebSocketMessage[] = []
  const runningFlag = { value: false }
  const spawnCalls: Array<{ cmd: string; args: string[]; opts: Record<string, unknown> }> = []
  const pendingTimers: Array<{ fireAt: number; fn: () => void }> = []
  let now = 0
  const child = createStubChild()
  const deps: RunControllerDeps = {
    getRunContext: (): RunContext | null => runCtx,
    port: 3000,
    broadcast: (msg): void => {
      broadcasts.push(msg)
    },
    setReportRunning: (running): void => {
      runningFlag.value = running
    },
    spawn: (cmd, args, opts): ChildProcessLike => {
      spawnCalls.push({ cmd, args, opts })
      return child
    },
    timers: {
      setTimeout: (fn, ms?): unknown => {
        const handle = { fireAt: now + (ms ?? 0), fn }
        pendingTimers.push(handle)
        return handle as unknown as ReturnType<typeof setTimeout>
      },
      clearTimeout: (handle): void => {
        const i = pendingTimers.indexOf(handle as { fireAt: number; fn: () => void })
        if (i >= 0) pendingTimers.splice(i, 1)
      },
    },
    resolveReporter,
  }
  const controller = new RunController(deps)
  return {
    controller,
    child,
    broadcasts,
    runningFlag,
    spawnCalls,
    advanceTimer: (ms): void => {
      now += ms
      for (const t of pendingTimers.splice(0)) {
        if (t.fireAt <= now) t.fn()
        else pendingTimers.push(t)
      }
    },
    setRunContext: (ctx): void => {
      runCtx = ctx
    },
  }
}

const SAMPLE_CTX: RunContext = { configFile: '/proj/playwright.config.ts', cwd: '/proj' }

describe('RunController.start', () => {
  test('refuses when no config registered', () => {
    const f = createFixture(null)
    const result = f.controller.start({})
    expect(result).toEqual({ ok: false, reason: 'no-config' })
    expect(f.spawnCalls).toHaveLength(0)
    expect(f.broadcasts).toHaveLength(0)
    expect(f.runningFlag.value).toBe(false)
  })

  test('spawns with --config and cwd on happy path', () => {
    const f = createFixture(SAMPLE_CTX)
    const result = f.controller.start({})
    expect(result).toEqual({ ok: true })
    expect(f.spawnCalls).toHaveLength(1)
    const { cmd, args, opts } = f.spawnCalls[0]!
    expect(cmd).toBe('npx')
    expect(args).toEqual(['playwright', 'test', '--config', '/proj/playwright.config.ts'])
    expect(opts.cwd).toBe('/proj')
    const env = opts.env as Record<string, string | undefined>
    expect(env.CRVY_RPRTR_SERVER_URL).toBe('ws://localhost:3000')
    expect(env.CI).toBeUndefined()
    expect(env.PLAYWRIGHT_HTML_OPEN).toBe('never')
    expect(f.runningFlag.value).toBe(true)
    expect(f.broadcasts).toEqual([{ type: 'run-status', data: { running: true } }])
    expect(f.controller.isRunning).toBe(true)
  })

  test('adds --reporter when resolveReporter returns a path', () => {
    const f = createFixture(SAMPLE_CTX, () => '/abs/path/to/reporter.js')
    f.controller.start({})
    expect(f.spawnCalls[0]!.args).toEqual([
      'playwright',
      'test',
      '--config',
      '/proj/playwright.config.ts',
      '--reporter',
      '/abs/path/to/reporter.js',
    ])
  })

  test('omits --reporter when resolveReporter returns null', () => {
    const f = createFixture(SAMPLE_CTX, () => null)
    f.controller.start({})
    expect(f.spawnCalls[0]!.args).toEqual(['playwright', 'test', '--config', '/proj/playwright.config.ts'])
  })

  test('refuses when already running', () => {
    const f = createFixture(SAMPLE_CTX)
    f.controller.start({})
    const second = f.controller.start({})
    expect(second).toEqual({ ok: false, reason: 'already-running' })
    expect(f.spawnCalls).toHaveLength(1)
  })

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
})

describe('RunController child exit', () => {
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

  test('resets state on nonzero exit', () => {
    const f = createFixture(SAMPLE_CTX)
    f.controller.start({})
    f.child.exitEmitters.forEach((cb) => cb(1))
    expect(f.runningFlag.value).toBe(false)
    expect(f.controller.isRunning).toBe(false)
  })

  test('treats spawn error event as immediate exit', () => {
    const f = createFixture(SAMPLE_CTX)
    f.controller.start({})
    f.child.errorEmitters.forEach((cb) => cb(new Error('ENOENT')))
    expect(f.runningFlag.value).toBe(false)
    expect(f.controller.isRunning).toBe(false)
    expect(f.broadcasts).toContainEqual({ type: 'run-status', data: { running: false } })
  })

  test('cleans up exactly once when error is followed by exit', () => {
    const f = createFixture(SAMPLE_CTX)
    f.controller.start({})
    f.child.errorEmitters.forEach((cb) => cb(new Error('ENOENT')))
    f.child.exitEmitters.forEach((cb) => cb(1))
    expect(f.runningFlag.value).toBe(false)
    expect(f.controller.isRunning).toBe(false)
    expect(f.broadcasts.filter((m) => m.type === 'run-status' && !m.data.running)).toHaveLength(1)
  })
})

describe('RunController.stop', () => {
  test('refuses when not running', () => {
    const f = createFixture(SAMPLE_CTX)
    expect(f.controller.stop()).toEqual({ ok: false, reason: 'not-running' })
  })

  test('sends SIGTERM on happy path', () => {
    const f = createFixture(SAMPLE_CTX)
    f.controller.start({})
    expect(f.controller.stop()).toEqual({ ok: true })
    expect(f.child.killed).toEqual(['SIGTERM'])
    f.child.exitEmitters.forEach((cb) => cb(0))
    expect(f.child.killed).toEqual(['SIGTERM'])
  })

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
})

describe('RunController.dispose', () => {
  test('SIGKILLs the current child immediately', () => {
    const f = createFixture(SAMPLE_CTX)
    f.controller.start({})
    f.controller.dispose()
    expect(f.child.killed).toEqual(['SIGKILL'])
  })
})
