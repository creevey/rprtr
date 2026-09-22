import { describe, expect, test } from 'bun:test'

import type { ContainerPathMapping } from '../src/server/docker-support'
import { gteMinor, resolveReporterDefault } from '../src/server/run-command-helpers'
import {
  RunController,
  type ChildProcessLike,
  type RunContext,
  type RunControllerDeps,
  buildTestListEntries,
} from '../src/server/run-controller'
import type { LaunchParams, LaunchSpec } from '../src/server/run-launcher'
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
  filteredCalls: boolean[]
  spawnCalls: Array<{ cmd: string; args: string[]; opts: Record<string, unknown> }>
  setResolveLaunch: (fn: ((cwd: string, args: string[]) => { cmd: string; args: string[] }) | null) => void
  advanceTimer: (ms: number) => void
  setRunContext: (ctx: RunContext | null) => void
  writtenTempFiles: Array<{ path: string; content: string }>
  deletedTempFiles: string[]
  setPlaywrightVersion: (version: string | null) => void
  setSpawnThrows: (flag: boolean) => void
  saveReportCalls: { value: number }
  setLauncherAvailable: (value: boolean | undefined) => void
  probeCalls: { value: number }
  setRunMode: (mode: 'local' | 'docker' | 'auto' | undefined) => void
  warnings: string[]
  prepareCalls: { value: number }
  setLauncherMode: (mode: 'local' | 'docker') => void
  setHasBrowserHook: (value: boolean) => void
  setSidecarEnsureFails: (value: boolean) => void
  sidecarEnsureCalls: { value: number }
  sidecarDisposeCalls: { value: number }
  sidecarPhases: string[]
  diagnoseCalls: { value: number }
  setLauncherDiagnose: (fn: (() => Promise<string[]>) | null) => void
  notifyRunSettledCalls: { value: number }
}

function createFixture(
  initialCtx: RunContext | null = null,
  resolveReporter: (cwd: string) => string | null = () => null,
  containerPathMapping?: ContainerPathMapping,
): Fixture {
  let runCtx: RunContext | null = initialCtx
  const broadcasts: ClientWebSocketMessage[] = []
  const runningFlag = { value: false }
  const filteredCalls: boolean[] = []
  const spawnCalls: Array<{ cmd: string; args: string[]; opts: Record<string, unknown> }> = []
  const pendingTimers: Array<{ fireAt: number; fn: () => void }> = []
  let now = 0
  let resolveLaunch: ((cwd: string, args: string[]) => { cmd: string; args: string[] }) | null = null
  let launcherAvailable: boolean | undefined
  const writtenTempFiles: Array<{ path: string; content: string }> = []
  const deletedTempFiles: string[] = []
  let playwrightVersion: string | null = null
  let spawnThrows = false
  let runMode: 'local' | 'docker' | 'auto' | undefined
  const saveReportCalls = { value: 0 }
  const probeCalls = { value: 0 }
  const warnings: string[] = []
  const prepareCalls = { value: 0 }
  let launcherMode: 'local' | 'docker' = 'local'
  let hasBrowserHook = false
  let sidecarEnsureFails = false
  const sidecarEnsureCalls = { value: 0 }
  const sidecarDisposeCalls = { value: 0 }
  const sidecarPhases: string[] = []
  const diagnoseCalls = { value: 0 }
  let launcherDiagnose: (() => Promise<string[]>) | null = null
  const notifyRunSettledCalls = { value: 0 }
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
    setRunFiltered: (filtered): void => {
      filteredCalls.push(filtered)
    },
    notifyRunSettled: (): void => {
      notifyRunSettledCalls.value += 1
    },
    spawn: (cmd, args, opts): ChildProcessLike => {
      spawnCalls.push({ cmd, args, opts })
      if (spawnThrows) throw new Error('spawn failed synchronously')
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
    containerPathMapping,
    launcher: {
      get mode(): 'local' | 'docker' {
        return launcherMode
      },
      get available(): boolean | undefined {
        return launcherAvailable
      },
      prepare: (): Promise<void> => {
        prepareCalls.value += 1
        return Promise.resolve()
      },
      diagnose: (): Promise<string[]> => {
        diagnoseCalls.value += 1
        return launcherDiagnose === null ? Promise.resolve([]) : launcherDiagnose()
      },
      launch: ({ ctx, playwrightArgs }: LaunchParams): LaunchSpec => {
        const name = ctx.runner === 'vitest' ? 'vitest' : 'playwright'
        const resolved = resolveLaunch?.(ctx.cwd, playwrightArgs) ?? {
          cmd: 'npx',
          args: [name, ...playwrightArgs],
        }
        return { cmd: resolved.cmd, args: resolved.args, env: { STUB_ENV: '1' } }
      },
    },
    browserSidecar: {
      endpoint: 'ws://127.0.0.1:49153/',
      image: SIDECAR_IMAGE,
      resolveImage: (): string => SIDECAR_IMAGE,
      ensure: (ctx, onProgress): Promise<string> => {
        sidecarEnsureCalls.value += 1
        onProgress('starting-sidecar')
        sidecarPhases.push('starting-sidecar')
        if (sidecarEnsureFails) return Promise.reject(new Error('sidecar unavailable'))
        return Promise.resolve('ws://127.0.0.1:49153/')
      },
      dispose: (): void => {
        sidecarDisposeCalls.value += 1
      },
    },
    readVitestPins: () => Promise.resolve([]),
    hasBrowserHook: (): boolean => hasBrowserHook,
    writeTempFile: (content: string): string => {
      const path = `/tmp/crvy-rprtr-test-list-${writtenTempFiles.length}.txt`
      writtenTempFiles.push({ path, content })
      return path
    },
    deleteTempFile: (path: string): void => {
      deletedTempFiles.push(path)
    },
    getPlaywrightVersion: (): string | null => {
      probeCalls.value += 1
      return playwrightVersion
    },
    saveReport: (): Promise<void> => {
      saveReportCalls.value++
      return Promise.resolve()
    },
    getRunMode: (): 'local' | 'docker' | 'auto' | undefined => runMode,
    warn: (message: string): void => {
      warnings.push(message)
    },
  }
  const controller = new RunController(deps)
  return {
    controller,
    child,
    broadcasts,
    runningFlag,
    filteredCalls,
    spawnCalls,
    setResolveLaunch: (fn): void => {
      resolveLaunch = fn
    },
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
    writtenTempFiles,
    deletedTempFiles,
    setPlaywrightVersion: (version): void => {
      playwrightVersion = version
    },
    setSpawnThrows: (flag): void => {
      spawnThrows = flag
    },
    saveReportCalls,
    setLauncherAvailable: (value): void => {
      launcherAvailable = value
    },
    probeCalls,
    setRunMode: (mode): void => {
      runMode = mode
    },
    warnings,
    prepareCalls,
    setLauncherMode: (mode): void => {
      launcherMode = mode
    },
    setHasBrowserHook: (value): void => {
      hasBrowserHook = value
    },
    setSidecarEnsureFails: (value): void => {
      sidecarEnsureFails = value
    },
    sidecarEnsureCalls,
    sidecarDisposeCalls,
    sidecarPhases,
    diagnoseCalls,
    setLauncherDiagnose: (fn): void => {
      launcherDiagnose = fn
    },
    notifyRunSettledCalls,
  }
}

const SAMPLE_CTX: RunContext = { configFile: '/proj/playwright.config.ts', cwd: '/proj' }

const SIDECAR_IMAGE = 'mcr.microsoft.com/playwright:v1.59.0-noble'

const VITEST_CTX: RunContext = {
  configFile: '/proj/vitest.config.ts',
  cwd: '/proj',
  rootDir: '/proj',
  runner: 'vitest',
}

describe('RunController.start Vitest runner', () => {
  test('full suite spawns vitest run --config without reporter injection or version probe', () => {
    const f = createFixture(VITEST_CTX, () => '/abs/path/to/reporter.js')
    f.setPlaywrightVersion('1.59.0')
    const result = f.controller.start({})
    expect(result).toEqual({ ok: true })
    expect(f.spawnCalls).toHaveLength(1)
    const { cmd, args, opts } = f.spawnCalls[0]!
    expect(cmd).toBe('npx')
    expect(args).toEqual(['vitest', 'run', '--config', '/proj/vitest.config.ts'])
    expect(opts.cwd).toBe('/proj')
    expect(f.writtenTempFiles).toHaveLength(0)
    expect(f.probeCalls.value).toBe(0)
  })

  test('update maps to --update', () => {
    const f = createFixture(VITEST_CTX)
    f.controller.start({ update: true })
    expect(f.spawnCalls[0]!.args).toEqual(['vitest', 'run', '--config', '/proj/vitest.config.ts', '--update'])
  })

  test('single test filters by file positional plus -t title-path pattern', () => {
    const f = createFixture(VITEST_CTX)
    f.setPlaywrightVersion('1.59.0')
    f.controller.start({
      tests: [
        {
          file: 'tests/button.test.ts',
          line: 3,
          projectName: 'chromium',
          titlePath: ['renders', 'primary button'],
        },
      ],
    })
    expect(f.spawnCalls[0]!.args).toEqual([
      'vitest',
      'run',
      '--config',
      '/proj/vitest.config.ts',
      '--project=chromium',
      'tests/button.test.ts',
      '-t',
      'renders primary button',
    ])
    expect(f.writtenTempFiles).toHaveLength(0)
  })

  test('descriptors sharing a project pass --project=<name> once', () => {
    const f = createFixture(VITEST_CTX)
    f.controller.start({
      tests: [
        { file: 'a.test.ts', line: 1, projectName: 'chromium', titlePath: ['t1'] },
        { file: 'a.test.ts', line: 5, projectName: 'chromium', titlePath: ['t2'] },
      ],
    })
    expect(f.spawnCalls[0]!.args).toEqual([
      'vitest',
      'run',
      '--config',
      '/proj/vitest.config.ts',
      '--project=chromium',
      'a.test.ts',
    ])
    expect(f.writtenTempFiles).toHaveLength(0)
  })

  test('descriptors with mixed projects omit --project', () => {
    const f = createFixture(VITEST_CTX)
    f.controller.start({
      tests: [
        { file: 'a.test.ts', line: 1, projectName: 'chromium', titlePath: ['t1'] },
        { file: 'b.test.ts', line: 2, projectName: 'firefox', titlePath: ['t2'] },
      ],
    })
    expect(f.spawnCalls[0]!.args).toEqual([
      'vitest',
      'run',
      '--config',
      '/proj/vitest.config.ts',
      'a.test.ts',
      'b.test.ts',
    ])
  })
})

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
    expect(env.STUB_ENV).toBe('1')
    expect(f.runningFlag.value).toBe(true)
    expect(f.broadcasts).toEqual([{ type: 'run-status', data: { running: true, mode: 'local' } }])
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

  test('uses the injected package-manager launcher when provided', () => {
    const f = createFixture(SAMPLE_CTX)
    f.setResolveLaunch((_cwd, args) => ({ cmd: 'pnpm', args: ['exec', 'playwright', ...args] }))
    f.controller.start({})
    expect(f.spawnCalls[0]!.cmd).toBe('pnpm')
    expect(f.spawnCalls[0]!.args).toEqual(['exec', 'playwright', 'test', '--config', '/proj/playwright.config.ts'])
  })

  test('refuses when already running', () => {
    const f = createFixture(SAMPLE_CTX)
    f.controller.start({})
    const second = f.controller.start({})
    expect(second).toEqual({ ok: false, reason: 'already-running' })
    expect(f.spawnCalls).toHaveLength(1)
  })

  test('single descriptor becomes positional file:line:column with --project', () => {
    const f = createFixture(SAMPLE_CTX, () => null)
    f.controller.start({
      tests: [
        { file: 'tests/foo.spec.ts', line: 42, column: 11, projectName: 'chromium', titlePath: ['suite', 'foo'] },
      ],
    })
    expect(f.spawnCalls[0]!.args).toEqual([
      'playwright',
      'test',
      '--config',
      '/proj/playwright.config.ts',
      '--project=chromium',
      'tests/foo.spec.ts:42:11',
    ])
  })

  test('docker mode routes a single descriptor through --test-list with rewritten paths', () => {
    // Positional file:line filters are host paths and cannot resolve inside the
    // container, so docker runs use --test-list even for a single test. Entries are
    // relative to Playwright's rootDir, which --test-list matches against.
    const f = createFixture(
      { configFile: '/proj/playwright.config.ts', cwd: '/proj', rootDir: '/proj/tests' },
      () => null,
      { from: '/work', to: '/proj' },
    )
    f.setPlaywrightVersion('1.59.0')
    f.controller.start({
      tests: [{ file: '/work/tests/foo.spec.ts', line: 42, projectName: 'chromium', titlePath: ['foo'] }],
    })

    expect(f.spawnCalls[0]!.args).toContain('--test-list')
    expect(f.spawnCalls[0]!.args).not.toContain('/proj/tests/foo.spec.ts:42')
    expect(f.writtenTempFiles[0]!.content).toBe('[chromium] \u203a foo.spec.ts:42 \u203a foo')
  })

  test('docker mode writes --test-list entries with POSIX separators', () => {
    const f = createFixture(SAMPLE_CTX, () => null, { from: '/work', to: 'C:\\proj' })
    f.setPlaywrightVersion('1.59.0')
    f.controller.start({
      tests: [{ file: 'tests\\foo.spec.ts', line: 10, titlePath: ['foo'] }],
    })
    expect(f.writtenTempFiles[0]!.content).toBe('tests/foo.spec.ts:10 \u203a foo')
  })

  test('local mode keeps host separators in --test-list entries', () => {
    const f = createFixture(SAMPLE_CTX)
    f.setPlaywrightVersion('1.59.0')
    f.controller.start({
      tests: [
        { file: 'tests\\a.spec.ts', line: 1, titlePath: ['a'] },
        { file: 'tests\\b.spec.ts', line: 2, titlePath: ['b'] },
      ],
    })
    expect(f.writtenTempFiles[0]!.content).toContain('tests\\a.spec.ts:1')
  })

  test('seeded run context without rootDir emits candidate test-list entries', () => {
    // Fresh server + report.json from a prior session: no register has arrived, so
    // Playwright's rootDir is unknown. Entries must cover every plausible base or the
    // run silently matches zero tests (exit 0, no output).
    const f = createFixture(SAMPLE_CTX, () => null, { from: '/work', to: '/proj' })
    f.setPlaywrightVersion('1.59.0')
    f.controller.start({
      tests: [{ file: '/work/tests/foo.spec.ts', line: 42, projectName: 'chromium', titlePath: ['foo'] }],
    })

    expect(f.writtenTempFiles[0]!.content).toBe(
      ['[chromium] \u203a tests/foo.spec.ts:42 \u203a foo', '[chromium] \u203a foo.spec.ts:42 \u203a foo'].join('\n'),
    )
  })

  test('multiple descriptors become positional args with shared --project', () => {
    const f = createFixture(SAMPLE_CTX, () => null)
    f.controller.start({
      tests: [
        { file: 'a.spec.ts', line: 1, projectName: 'chromium', titlePath: ['t1'] },
        { file: 'b.spec.ts', line: 2, column: 3, projectName: 'chromium', titlePath: ['t2'] },
      ],
    })
    expect(f.spawnCalls[0]!.args).toEqual([
      'playwright',
      'test',
      '--config',
      '/proj/playwright.config.ts',
      '--project=chromium',
      'a.spec.ts:1',
      'b.spec.ts:2:3',
    ])
  })

  test('multiple descriptors with mixed projects omit --project', () => {
    const f = createFixture(SAMPLE_CTX, () => null)
    f.controller.start({
      tests: [
        { file: 'a.spec.ts', line: 1, projectName: 'chromium', titlePath: ['t1'] },
        { file: 'b.spec.ts', line: 2, projectName: 'firefox', titlePath: ['t2'] },
      ],
    })
    expect(f.spawnCalls[0]!.args).toEqual([
      'playwright',
      'test',
      '--config',
      '/proj/playwright.config.ts',
      'a.spec.ts:1',
      'b.spec.ts:2',
    ])
  })

  test('empty tests array returns no-tests without spawning', () => {
    const f = createFixture(SAMPLE_CTX)
    const result = f.controller.start({ tests: [] })
    expect(result).toEqual({ ok: false, reason: 'no-tests' })
    expect(f.spawnCalls).toHaveLength(0)
    expect(f.broadcasts).toHaveLength(0)
  })

  test('appends --update-snapshots when update is true', () => {
    const f = createFixture(SAMPLE_CTX, () => null)
    f.controller.start({ update: true })
    expect(f.spawnCalls[0]!.args).toEqual([
      'playwright',
      'test',
      '--config',
      '/proj/playwright.config.ts',
      '--update-snapshots',
    ])
  })

  test('refuses with docker-unavailable when the launcher is unavailable', () => {
    const f = createFixture(SAMPLE_CTX)
    f.setLauncherAvailable(false)
    const result = f.controller.start({})
    expect(result).toEqual({ ok: false, reason: 'docker-unavailable' })
    expect(f.spawnCalls).toHaveLength(0)
  })
})

describe('RunController.start Vitest docker scoping', () => {
  test('explicit docker with the hook spawns local vitest with the sidecar endpoint', async () => {
    const f = createFixture(VITEST_CTX)
    f.setRunMode('docker')
    f.setLauncherMode('docker')
    f.setHasBrowserHook(true)
    expect(await f.controller.prepareRun()).toEqual({ ok: true })
    expect(f.sidecarEnsureCalls.value).toBe(1)
    const result = f.controller.start({})
    expect(result).toEqual({ ok: true })
    expect(f.spawnCalls).toHaveLength(1)
    expect(f.spawnCalls[0]!.args).toEqual(['vitest', 'run', '--config', '/proj/vitest.config.ts'])
    expect(f.spawnCalls[0]!.opts.env).toMatchObject({
      CRVY_RPRTR_BROWSER_WS: 'ws://127.0.0.1:49153/',
      CRVY_RPRTR_DOCKER_IMAGE: SIDECAR_IMAGE,
    })
    expect(f.broadcasts).toContainEqual({ type: 'run-status', data: { running: true, mode: 'docker' } })
    expect(f.warnings).toHaveLength(0)
  })

  test('explicit docker without the hook refuses with docker-missing-browser-hook', () => {
    const f = createFixture(VITEST_CTX)
    f.setRunMode('docker')
    f.setLauncherMode('docker')
    f.setHasBrowserHook(false)
    const result = f.controller.start({})
    expect(result).toEqual({ ok: false, reason: 'docker-missing-browser-hook' })
    expect(f.spawnCalls).toHaveLength(0)
    expect(f.sidecarEnsureCalls.value).toBe(0)
    expect(f.broadcasts).toHaveLength(0)
    expect(f.runningFlag.value).toBe(false)
    expect(f.warnings).toHaveLength(0)
  })

  test('auto with a docker backend and no hook falls back to a local spawn with one warning', () => {
    const f = createFixture(VITEST_CTX)
    f.setRunMode('auto')
    f.setLauncherMode('docker')
    f.setHasBrowserHook(false)
    const result = f.controller.start({})
    expect(result).toEqual({ ok: true })
    expect(f.spawnCalls).toHaveLength(1)
    expect((f.spawnCalls[0]!.opts.env as Record<string, string | undefined>).CRVY_RPRTR_BROWSER_WS).toBeUndefined()
    expect(f.broadcasts).toEqual([{ type: 'run-status', data: { running: true, mode: 'local' } }])
    expect(f.warnings).toHaveLength(1)
  })

  test('auto with a docker backend and the hook uses the sidecar', async () => {
    const f = createFixture(VITEST_CTX)
    f.setRunMode('auto')
    f.setLauncherMode('docker')
    f.setHasBrowserHook(true)
    expect(await f.controller.prepareRun()).toEqual({ ok: true })
    const result = f.controller.start({})
    expect(result).toEqual({ ok: true })
    expect(f.sidecarEnsureCalls.value).toBe(1)
    expect(f.spawnCalls[0]!.opts.env).toMatchObject({ CRVY_RPRTR_BROWSER_WS: 'ws://127.0.0.1:49153/' })
    expect(f.broadcasts).toContainEqual({ type: 'run-status', data: { running: true, mode: 'docker' } })
  })

  test('auto with a local backend never touches the sidecar or warns', () => {
    const f = createFixture(VITEST_CTX)
    f.setRunMode('auto')
    f.setHasBrowserHook(true)
    const result = f.controller.start({})
    expect(result).toEqual({ ok: true })
    expect(f.spawnCalls).toHaveLength(1)
    expect((f.spawnCalls[0]!.opts.env as Record<string, string | undefined>).CRVY_RPRTR_BROWSER_WS).toBeUndefined()
    expect(f.sidecarEnsureCalls.value).toBe(0)
    expect(f.broadcasts).toEqual([{ type: 'run-status', data: { running: true, mode: 'local' } }])
    expect(f.warnings).toHaveLength(0)
  })

  test('local run mode spawns locally without warning or sidecar interaction', () => {
    const f = createFixture(VITEST_CTX)
    f.setRunMode('local')
    f.setHasBrowserHook(true)
    const result = f.controller.start({})
    expect(result).toEqual({ ok: true })
    expect(f.spawnCalls).toHaveLength(1)
    expect(f.spawnCalls[0]!.args[0]).toBe('vitest')
    const env = f.spawnCalls[0]!.opts.env as Record<string, string | undefined>
    expect(env.CRVY_RPRTR_BROWSER_WS).toBeUndefined()
    expect(env.CRVY_RPRTR_DOCKER_IMAGE).toBeUndefined()
    expect(f.sidecarEnsureCalls.value).toBe(0)
    expect(f.warnings).toHaveLength(0)
  })

  test('a sidecar run cannot start before a successful prepare', () => {
    const f = createFixture(VITEST_CTX)
    f.setRunMode('docker')
    f.setLauncherMode('docker')
    f.setHasBrowserHook(true)
    const result = f.controller.start({})
    expect(result).toEqual({ ok: false, reason: 'docker-unavailable' })
    expect(f.spawnCalls).toHaveLength(0)
    expect(f.runningFlag.value).toBe(false)
  })

  test('Playwright runs ignore the docker scoping branch', () => {
    const f = createFixture(SAMPLE_CTX)
    f.setRunMode('docker')
    const result = f.controller.start({})
    expect(result).toEqual({ ok: true })
    expect(f.spawnCalls).toHaveLength(1)
    expect(f.spawnCalls[0]!.args[0]).toBe('playwright')
    expect(f.warnings).toHaveLength(0)
  })

  test('Vitest runs without a docker backend never trigger docker preparation', async () => {
    const f = createFixture(VITEST_CTX)
    f.setRunMode('docker')
    f.setLauncherMode('docker')
    f.setHasBrowserHook(false)
    const preparation = await f.controller.prepareRun()
    expect(preparation).toEqual({ ok: true })
    expect(f.prepareCalls.value).toBe(0)
    expect(f.sidecarEnsureCalls.value).toBe(0)
  })

  test('Playwright runs still prepare', async () => {
    const f = createFixture(SAMPLE_CTX)
    f.setRunMode('docker')
    const preparation = await f.controller.prepareRun()
    expect(preparation).toEqual({ ok: true })
    expect(f.prepareCalls.value).toBe(1)
  })
})

describe('RunController.prepareRun Vitest sidecar', () => {
  test('ensures the sidecar and broadcasts its phases with docker mode', async () => {
    const f = createFixture(VITEST_CTX)
    f.setRunMode('docker')
    f.setLauncherMode('docker')
    f.setHasBrowserHook(true)
    expect(await f.controller.prepareRun()).toEqual({ ok: true })
    expect(f.sidecarEnsureCalls.value).toBe(1)
    expect(f.sidecarPhases).toEqual(['starting-sidecar'])
    expect(f.broadcasts).toEqual([
      { type: 'run-status', data: { running: true, mode: 'docker', phase: 'starting-sidecar' } },
    ])
    expect(f.prepareCalls.value).toBe(0)
  })

  test('sidecar ensure failure reports docker-unavailable and the run never spawns', async () => {
    const f = createFixture(VITEST_CTX)
    f.setRunMode('docker')
    f.setLauncherMode('docker')
    f.setHasBrowserHook(true)
    f.setSidecarEnsureFails(true)
    expect(await f.controller.prepareRun()).toEqual({ ok: false, reason: 'docker-unavailable' })
    expect(f.broadcasts).toContainEqual({ type: 'run-status', data: { running: false, mode: 'docker' } })
    expect(f.controller.start({})).toEqual({ ok: false, reason: 'docker-unavailable' })
    expect(f.spawnCalls).toHaveLength(0)
    expect(f.runningFlag.value).toBe(false)
  })

  test('local-mode Vitest runs skip the sidecar', async () => {
    const f = createFixture(VITEST_CTX)
    f.setRunMode('local')
    f.setLauncherMode('docker')
    f.setHasBrowserHook(true)
    expect(await f.controller.prepareRun()).toEqual({ ok: true })
    expect(f.sidecarEnsureCalls.value).toBe(0)
  })

  test('auto without the hook skips the sidecar and warns only on start', async () => {
    const f = createFixture(VITEST_CTX)
    f.setRunMode('auto')
    f.setLauncherMode('docker')
    f.setHasBrowserHook(false)
    expect(await f.controller.prepareRun()).toEqual({ ok: true })
    expect(f.sidecarEnsureCalls.value).toBe(0)
    expect(f.warnings).toHaveLength(0)
    f.controller.start({})
    expect(f.warnings).toHaveLength(1)
  })

  test('dispose tears down the sidecar even without a running child', () => {
    const f = createFixture(VITEST_CTX)
    f.controller.dispose()
    expect(f.sidecarDisposeCalls.value).toBe(1)
  })

  test('the stop force-kill path tears down the sidecar', async () => {
    const f = createFixture(VITEST_CTX)
    f.setRunMode('docker')
    f.setLauncherMode('docker')
    f.setHasBrowserHook(true)
    await f.controller.prepareRun()
    f.controller.start({})
    f.controller.stop()
    f.advanceTimer(5000)
    expect(f.sidecarDisposeCalls.value).toBe(1)
  })

  test('the run-status broadcast on child exit keeps the docker mode', async () => {
    const f = createFixture(VITEST_CTX)
    f.setRunMode('docker')
    f.setLauncherMode('docker')
    f.setHasBrowserHook(true)
    await f.controller.prepareRun()
    f.controller.start({})
    f.child.exitEmitters.forEach((cb) => cb(0))
    expect(f.broadcasts).toContainEqual({ type: 'run-status', data: { running: false, mode: 'docker' } })
  })
})

describe('RunController.prepareRun notices', () => {
  test('collects diagnostic notices for a docker context', async () => {
    const f = createFixture(SAMPLE_CTX)
    f.setLauncherMode('docker')
    f.setLauncherDiagnose(() => Promise.resolve(['Docker mode: nothing serves http://host.docker.internal:6006']))

    expect(await f.controller.prepareRun()).toEqual({
      ok: true,
      notices: ['Docker mode: nothing serves http://host.docker.internal:6006'],
    })
    expect(f.diagnoseCalls.value).toBe(1)
  })

  test('omits notices when the diagnostic finds no divergence', async () => {
    const f = createFixture(SAMPLE_CTX)
    f.setLauncherMode('docker')
    f.setLauncherDiagnose(() => Promise.resolve([]))

    expect(await f.controller.prepareRun()).toEqual({ ok: true })
  })

  test('treats a throwing diagnostic as no notices and does not block', async () => {
    const f = createFixture(SAMPLE_CTX)
    f.setLauncherMode('docker')
    f.setLauncherDiagnose(() => Promise.reject(new Error('probe exploded')))

    expect(await f.controller.prepareRun()).toEqual({ ok: true })
  })

  test('the running broadcast after a warned prepare carries the notices and logs them', async () => {
    const f = createFixture(SAMPLE_CTX)
    f.setLauncherMode('docker')
    f.setLauncherDiagnose(() => Promise.resolve(['notice A', 'notice B']))
    expect(await f.controller.prepareRun()).toEqual({ ok: true, notices: ['notice A', 'notice B'] })

    f.controller.start({})

    expect(f.broadcasts).toContainEqual({
      type: 'run-status',
      data: { running: true, mode: 'docker', notices: ['notice A', 'notice B'] },
    })
    expect(f.warnings).toEqual(['notice A', 'notice B'])
  })

  test('a run without notices broadcasts the plain running status', async () => {
    const f = createFixture(SAMPLE_CTX)
    f.setLauncherMode('docker')
    f.setLauncherDiagnose(() => Promise.resolve([]))
    await f.controller.prepareRun()

    f.controller.start({})

    expect(f.broadcasts).toEqual([{ type: 'run-status', data: { running: true, mode: 'docker' } }])
    expect(f.warnings).toEqual([])
  })

  test('notices never reach report persistence or artifacts', async () => {
    const f = createFixture(SAMPLE_CTX)
    f.setLauncherMode('docker')
    f.setLauncherDiagnose(() => Promise.resolve(['notice A']))
    await f.controller.prepareRun()

    f.controller.start({})

    // Report persistence only ever sees running flags: notices live on the broadcast,
    // and run-end still only flips the running flag and saves the report.
    expect(f.runningFlag.value).toBe(true)
    expect(f.filteredCalls).toEqual([false])
    expect(f.broadcasts).toContainEqual({
      type: 'run-status',
      data: { running: true, mode: 'docker', notices: ['notice A'] },
    })

    f.child.exitEmitters.forEach((cb) => cb(0))
    expect(f.runningFlag.value).toBe(false)
    expect(f.saveReportCalls.value).toBe(1)
  })
})

describe('RunController.start run scope signaling', () => {
  test('signals an unfiltered run when tests is absent', () => {
    const f = createFixture(SAMPLE_CTX)
    f.controller.start({})
    expect(f.filteredCalls).toEqual([false])
  })

  test('signals a filtered run when tests is provided', () => {
    const f = createFixture(SAMPLE_CTX)
    f.controller.start({ tests: [{ file: 'a.spec.ts', line: 1, titlePath: ['t'] }] })
    expect(f.filteredCalls).toEqual([true])
  })
})

describe('RunController child exit', () => {
  test('resets state on clean exit', () => {
    const f = createFixture(SAMPLE_CTX)
    f.controller.start({})
    f.child.exitEmitters.forEach((cb) => cb(0))
    expect(f.runningFlag.value).toBe(false)
    expect(f.broadcasts).toEqual([
      { type: 'run-status', data: { running: true, mode: 'local' } },
      { type: 'run-status', data: { running: false, mode: 'local' } },
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
    expect(f.broadcasts).toContainEqual({ type: 'run-status', data: { running: false, mode: 'local' } })
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

  test('flushes the report on exit so an interrupted run still persists', async () => {
    const f = createFixture(SAMPLE_CTX)
    f.controller.start({})
    f.saveReportCalls.value = 0
    f.child.exitEmitters.forEach((cb) => cb(0))
    // The exit handler fire-and-forgets the save; let it resolve.
    await Promise.resolve()
    await Promise.resolve()
    expect(f.saveReportCalls.value).toBe(1)
  })

  test('flushes the report on spawn error event', async () => {
    const f = createFixture(SAMPLE_CTX)
    f.controller.start({})
    f.saveReportCalls.value = 0
    f.child.errorEmitters.forEach((cb) => cb(new Error('ENOENT')))
    await Promise.resolve()
    await Promise.resolve()
    expect(f.saveReportCalls.value).toBe(1)
  })

  test('does not double-flush when error is followed by exit', async () => {
    const f = createFixture(SAMPLE_CTX)
    f.controller.start({})
    f.child.errorEmitters.forEach((cb) => cb(new Error('ENOENT')))
    f.child.exitEmitters.forEach((cb) => cb(1))
    await Promise.resolve()
    await Promise.resolve()
    expect(f.saveReportCalls.value).toBe(1)
  })

  test('notifies the discovery session when a UI-launched child exits', () => {
    const f = createFixture(SAMPLE_CTX)
    f.controller.start({})
    expect(f.notifyRunSettledCalls.value).toBe(0)
    f.child.exitEmitters.forEach((cb) => cb(0))
    expect(f.notifyRunSettledCalls.value).toBe(1)
  })

  test('notifies the discovery session once when a spawn error is followed by exit', () => {
    const f = createFixture(SAMPLE_CTX)
    f.controller.start({})
    f.child.errorEmitters.forEach((cb) => cb(new Error('ENOENT')))
    f.child.exitEmitters.forEach((cb) => cb(1))
    expect(f.notifyRunSettledCalls.value).toBe(1)
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

// `resolveReporterDefault` has two branches: (1) resolve `@crvy/rprtr` from the
// project cwd, (2) fall back to `import.meta.url` (the server's own module, which
// IS @crvy/rprtr). In the bun test environment branch 1 throws for cwds where the
// package isn't resolvable (verified: `/proj` and nonexistent paths throw), so the
// two tests below cover both branches: test 1 uses a real in-repo cwd where branch 1
// succeeds via package self-referencing; test 2 uses a nonexistent cwd so branch 1
// throws and resolution succeeds only via the import.meta.url fallback.
describe('resolveReporterDefault', () => {
  test('resolves from the project cwd when installed there', () => {
    // `process.cwd()` is the tests/ dir during `cd tests && bun test`; it sits inside
    // the repo where @crvy/rprtr is the self-published package, so branch 1 resolves it.
    expect(resolveReporterDefault(process.cwd())).not.toBeNull()
  })

  test('falls back to the server module location when the project cwd throws', () => {
    // A cwd with no resolvable @crvy/rprtr should still resolve via import.meta.url
    // because the server IS @crvy/rprtr.
    expect(resolveReporterDefault('/nonexistent/project/path')).not.toBeNull()
  })
})

// The expected line below is a real line from
// tests/fixtures/playwright-list-sample.txt (captured via
// `playwright test --list --reporter=list`). It pins the entry format so that
// `buildTestListEntries` stays aligned with Playwright's own `--list` output —
// which is what `--test-list` matches against. The file path in the sample is
// relative to the Playwright `testDir` (here the spec basename).
describe('gteMinor', () => {
  test('true when version meets the threshold', () => {
    expect(gteMinor('1.56.0', 1, 56)).toBe(true)
    expect(gteMinor('1.59.0-beta', 1, 56)).toBe(true)
    expect(gteMinor('2.0.0', 1, 56)).toBe(true)
  })
  test('false when version is below the threshold', () => {
    expect(gteMinor('1.55.0', 1, 56)).toBe(false)
    expect(gteMinor('1.40.1', 1, 56)).toBe(false)
  })
  test('false for unparseable input', () => {
    expect(gteMinor('', 1, 56)).toBe(false)
    expect(gteMinor('not-a-version', 1, 56)).toBe(false)
  })
})

describe('buildTestListEntries', () => {
  test('formats one line per descriptor matching playwright --list shape', () => {
    const entries = buildTestListEntries([
      {
        file: 'offline-artifact.spec.ts',
        line: 19,
        column: 3,
        projectName: 'chromium',
        titlePath: ['opens the generated report artifact directly from disk'],
      },
    ])
    // Exactly matches line 2 of playwright-list-sample.txt (minus leading spaces):
    //   [chromium] › offline-artifact.spec.ts:19:3 › opens the generated report artifact directly from disk
    expect(entries).toEqual([
      '[chromium] \u203a offline-artifact.spec.ts:19:3 \u203a opens the generated report artifact directly from disk',
    ])
  })

  test('omits the project prefix when projectName is empty/absent', () => {
    const entries = buildTestListEntries([{ file: 'tests/foo.spec.ts', line: 10, titlePath: ['does a thing'] }])
    expect(entries).toEqual(['tests/foo.spec.ts:10 \u203a does a thing'])
  })

  test('converts absolute file paths to rootDir-relative when rootDir is provided', () => {
    // Playwright 1.59+ reports test.location.file as an absolute path; --test-list matches
    // against path.relative(config.rootDir, test.location.file), so absolute paths must be
    // converted before being written to the temp file.
    const entries = buildTestListEntries(
      [
        {
          file: '/proj/tests/offline-artifact.spec.ts',
          line: 19,
          column: 3,
          projectName: 'chromium',
          titlePath: ['opens the generated report artifact directly from disk'],
        },
      ],
      '/proj/tests',
    )
    expect(entries).toEqual([
      '[chromium] \u203a offline-artifact.spec.ts:19:3 \u203a opens the generated report artifact directly from disk',
    ])
  })

  test('leaves relative paths unchanged even when rootDir is provided', () => {
    const entries = buildTestListEntries(
      [{ file: 'a.spec.ts', line: 1, projectName: 'chromium', titlePath: ['t1'] }],
      '/proj/tests',
    )
    expect(entries).toEqual(['[chromium] \u203a a.spec.ts:1 \u203a t1'])
  })

  test('posix pathStyle converts backslashes in file paths', () => {
    const entries = buildTestListEntries(
      [{ file: 'tests\\foo.spec.ts', line: 10, titlePath: ['does a thing'] }],
      undefined,
      undefined,
      'posix',
    )
    expect(entries).toEqual(['tests/foo.spec.ts:10 \u203a does a thing'])
  })

  test('host pathStyle (default) preserves backslashes', () => {
    const entries = buildTestListEntries([{ file: 'tests\\foo.spec.ts', line: 10, titlePath: ['does a thing'] }])
    expect(entries).toEqual(['tests\\foo.spec.ts:10 \u203a does a thing'])
  })
})

describe('RunController --test-list path', () => {
  test('suite uses --test-list on Playwright >= 1.56 and cleans up on exit', () => {
    const f = createFixture(SAMPLE_CTX, () => null)
    f.setPlaywrightVersion('1.56.0')
    const descriptors = [
      { file: 'a.spec.ts', line: 1, projectName: 'chromium', titlePath: ['t1'] },
      { file: 'b.spec.ts', line: 2, projectName: 'chromium', titlePath: ['t2'] },
    ]
    const result = f.controller.start({ tests: descriptors })
    expect(result).toEqual({ ok: true })
    expect(f.spawnCalls[0]!.args).toContain('--test-list')
    const listPath = f.spawnCalls[0]!.args[f.spawnCalls[0]!.args.indexOf('--test-list') + 1]!
    expect(f.writtenTempFiles).toHaveLength(1)
    expect(f.writtenTempFiles[0]!.path).toBe(listPath)
    expect(f.writtenTempFiles[0]!.content).toBe(
      '[chromium] \u203a a.spec.ts:1 \u203a t1\n[chromium] \u203a b.spec.ts:2 \u203a t2',
    )
    f.child.exitEmitters.forEach((cb) => cb(0))
    expect(f.deletedTempFiles).toContain(listPath)
  })

  test('suite --test-list rewrites absolute descriptor paths to ctx.cwd-relative entries', () => {
    // Reproduces the silent "Run produced no results" failure on Playwright 1.59+:
    // the reporter forwards test.location.file as absolute, but --test-list matches
    // against path.relative(config.rootDir, test.location.file). The controller must
    // pass ctx.cwd (= config.rootDir from the reporter's register message) through
    // to buildTestListEntries so the temp file contains rootDir-relative paths.
    const f = createFixture({ ...SAMPLE_CTX, cwd: '/proj/tests' }, () => null)
    f.setPlaywrightVersion('1.59.0')
    f.controller.start({
      tests: [
        { file: '/proj/tests/a.spec.ts', line: 1, projectName: 'chromium', titlePath: ['t1'] },
        { file: '/proj/tests/b.spec.ts', line: 2, projectName: 'chromium', titlePath: ['t2'] },
      ],
    })
    expect(f.writtenTempFiles[0]!.content).toBe(
      '[chromium] \u203a a.spec.ts:1 \u203a t1\n[chromium] \u203a b.spec.ts:2 \u203a t2',
    )
  })

  test('suite falls back to positional args on Playwright < 1.56', () => {
    const f = createFixture(SAMPLE_CTX, () => null)
    f.setPlaywrightVersion('1.55.0')
    f.controller.start({
      tests: [
        { file: 'a.spec.ts', line: 1, projectName: 'chromium', titlePath: ['t1'] },
        { file: 'b.spec.ts', line: 2, projectName: 'chromium', titlePath: ['t2'] },
      ],
    })
    expect(f.spawnCalls[0]!.args).not.toContain('--test-list')
    expect(f.writtenTempFiles).toHaveLength(0)
    expect(f.spawnCalls[0]!.args).toContain('a.spec.ts:1')
  })

  test('temp file is deleted on dispose', () => {
    const f = createFixture(SAMPLE_CTX, () => null)
    f.setPlaywrightVersion('1.59.0')
    f.controller.start({
      tests: [
        { file: 'a.spec.ts', line: 1, titlePath: ['t1'] },
        { file: 'b.spec.ts', line: 2, titlePath: ['t2'] },
      ],
    })
    const listPath = f.spawnCalls[0]!.args[f.spawnCalls[0]!.args.indexOf('--test-list') + 1]!
    f.controller.dispose()
    expect(f.deletedTempFiles).toContain(listPath)
  })

  test('cleans up the temp file and propagates when spawn throws synchronously', () => {
    const f = createFixture(SAMPLE_CTX, () => null)
    f.setPlaywrightVersion('1.56.0')
    f.setSpawnThrows(true)
    const descriptors = [
      { file: 'a.spec.ts', line: 1, projectName: 'chromium', titlePath: ['t1'] },
      { file: 'b.spec.ts', line: 2, projectName: 'chromium', titlePath: ['t2'] },
    ]
    expect(() => f.controller.start({ tests: descriptors })).toThrow('spawn failed synchronously')
    expect(f.writtenTempFiles).toHaveLength(1)
    expect(f.deletedTempFiles).toContain(f.writtenTempFiles[0]!.path)
    expect(f.controller.isRunning).toBe(false)
    expect(f.broadcasts).not.toContainEqual({ type: 'run-status', data: { running: true, mode: 'local' } })
  })
})
