import { describe, expect, test } from 'bun:test'
import { existsSync, writeFileSync } from 'fs'

import { createDebugLogger } from '../src/debug-log'
import { readPlaywrightListWithConfig } from '../src/project-pins'
import { configDumpReporterPath, DOCKER_CONFIG_DUMP_ENV } from '../src/server/config-dump'
import {
  parsePlaywrightListReport,
  runPlaywrightList,
  synthesizePlaywrightDiscoveredTests,
  type PlaywrightListEntry,
} from '../src/server/playwright-discovery'

const ROOT_DIR = '/proj/tests'

/**
 * Shape of `playwright test --list --reporter=json` (verified against
 * Playwright 1.59/1.63): one merged file suite per test file, specs carrying
 * rootDir-relative locations, and one `tests[]` entry per project.
 */
function listReport(): Record<string, unknown> {
  return {
    config: {
      configFile: '/proj/playwright.config.ts',
      rootDir: ROOT_DIR,
      projects: [{ name: 'chromium' }, { name: 'firefox' }],
    },
    suites: [
      {
        title: 'a.spec.ts',
        file: 'a.spec.ts',
        column: 0,
        line: 0,
        specs: [
          {
            title: 'flat test',
            ok: true,
            tags: [],
            tests: [
              { projectName: 'chromium', status: 'skipped' },
              { projectName: 'firefox', status: 'skipped' },
            ],
            id: 'flat-chromium',
            file: 'a.spec.ts',
            line: 3,
            column: 5,
          },
        ],
        suites: [
          {
            title: 'outer',
            file: 'a.spec.ts',
            line: 7,
            column: 6,
            specs: [],
            suites: [
              {
                title: 'inner',
                file: 'a.spec.ts',
                line: 8,
                column: 8,
                specs: [
                  {
                    title: 'nested test',
                    ok: true,
                    tags: [],
                    tests: [{ projectName: 'chromium', status: 'skipped' }],
                    id: 'nested-chromium',
                    file: 'a.spec.ts',
                    line: 9,
                    column: 10,
                  },
                ],
              },
            ],
          },
        ],
      },
      {
        title: 'nested.spec.ts',
        file: 'deep/nested.spec.ts',
        column: 0,
        line: 0,
        specs: [
          {
            title: 'reaches the bottom',
            ok: true,
            tags: [],
            tests: [{ projectName: 'firefox', status: 'skipped' }],
            id: 'deep-firefox',
            file: 'deep/nested.spec.ts',
            line: 2,
            column: 3,
          },
        ],
      },
    ],
  }
}

interface FakeChild {
  stdout: { on(event: 'data', cb: (chunk: string | Buffer) => void): void }
  stderr: { on(event: 'data', cb: (chunk: string | Buffer) => void): void }
  on(event: 'close', cb: (code: number | null) => void): void
  on(event: 'error', cb: (err: Error) => void): void
  kill(signal?: string): void
  killedWith?: string
}

interface SpawnCall {
  cmd: string
  args: string[]
  opts: Record<string, unknown>
  child: FakeChild
}

interface FakeSpawnOptions {
  stdout?: string
  stderr?: string
  exitCode?: number | null
  emitError?: Error
  neverCloses?: boolean
  /** Runs synchronously at spawn time; mirrors a reporter writing its side output. */
  onSpawn?: (args: string[], opts: Record<string, unknown>) => void
}

function createFakeSpawn(options: FakeSpawnOptions): {
  spawn: (cmd: string, args: string[], opts: Record<string, unknown>) => FakeChild
  calls: SpawnCall[]
} {
  const calls: SpawnCall[] = []
  const spawn = (cmd: string, args: string[], opts: Record<string, unknown>): FakeChild => {
    const handlers: Record<string, ((...args: unknown[]) => void)[]> = {}
    const child: FakeChild = {
      stdout: {
        on: (_event, cb): void => {
          if (options.stdout !== undefined) queueMicrotask(() => cb(options.stdout!))
        },
      },
      stderr: {
        on: (_event, cb): void => {
          if (options.stderr !== undefined) queueMicrotask(() => cb(options.stderr!))
        },
      },
      on: (event, cb): void => {
        const invoke = cb as (payload: unknown) => void
        const list = handlers[event] ?? []
        list.push(invoke)
        handlers[event] = list
        if (options.neverCloses === true) return
        queueMicrotask(() => {
          if (event === 'error' && options.emitError !== undefined) invoke(options.emitError)
          if (event === 'close') invoke(options.exitCode ?? 0)
        })
      },
      kill: (signal): void => {
        child.killedWith = signal ?? 'SIGTERM'
      },
    }
    calls.push({ cmd, args, opts, child })
    options.onSpawn?.(args, opts)
    return child
  }
  return { spawn, calls }
}

describe('parsePlaywrightListReport', () => {
  test('emits one entry per project test with nested describe title paths', () => {
    const entries = parsePlaywrightListReport(listReport())

    expect(entries).toEqual([
      {
        file: '/proj/tests/a.spec.ts',
        titlePath: [],
        title: 'flat test',
        projectName: 'chromium',
        line: 3,
        column: 5,
      },
      {
        file: '/proj/tests/a.spec.ts',
        titlePath: [],
        title: 'flat test',
        projectName: 'firefox',
        line: 3,
        column: 5,
      },
      {
        file: '/proj/tests/a.spec.ts',
        titlePath: ['outer', 'inner'],
        title: 'nested test',
        projectName: 'chromium',
        line: 9,
        column: 10,
      },
      {
        file: '/proj/tests/deep/nested.spec.ts',
        titlePath: [],
        title: 'reaches the bottom',
        projectName: 'firefox',
        line: 2,
        column: 3,
      },
    ])
  })

  test('resolves every rootDir-relative file against rootDir', () => {
    const entries = parsePlaywrightListReport(listReport())
    expect(entries.map(({ file }) => file)).toEqual([
      '/proj/tests/a.spec.ts',
      '/proj/tests/a.spec.ts',
      '/proj/tests/a.spec.ts',
      '/proj/tests/deep/nested.spec.ts',
    ])
  })

  test('reports without a config rootDir or suites yield an empty list', () => {
    expect(parsePlaywrightListReport({})).toEqual([])
    expect(parsePlaywrightListReport(null)).toEqual([])
    expect(parsePlaywrightListReport({ config: { rootDir: ROOT_DIR } })).toEqual([])
    expect(parsePlaywrightListReport({ suites: [] })).toEqual([])
  })

  test('skips malformed specs and tests instead of throwing', () => {
    const entries = parsePlaywrightListReport({
      config: { rootDir: ROOT_DIR },
      suites: [
        {
          title: 'broken.spec.ts',
          file: 'broken.spec.ts',
          specs: [
            { title: 'no tests array', file: 'broken.spec.ts', line: 1 },
            { title: 42, file: 'broken.spec.ts', line: 2, tests: [{ projectName: 'chromium' }] },
            { title: 'no file', line: 3, tests: [{ projectName: 'chromium' }] },
            {
              title: 'kept',
              file: 'broken.spec.ts',
              line: 4,
              tests: [{ projectName: 'chromium' }, { projectName: 42 }],
            },
          ],
        },
      ],
    })

    expect(entries).toEqual([
      { file: '/proj/tests/broken.spec.ts', titlePath: [], title: 'kept', projectName: 'chromium', line: 4 },
    ])
  })
})

describe('synthesizePlaywrightDiscoveredTests', () => {
  const configDir = '/proj'

  const entries: PlaywrightListEntry[] = [
    {
      file: '/proj/tests/a.spec.ts',
      titlePath: [],
      title: 'flat test',
      projectName: 'chromium',
      line: 3,
      column: 5,
    },
    {
      file: '/proj/tests/a.spec.ts',
      titlePath: ['outer', 'inner'],
      title: 'nested test',
      projectName: 'firefox',
      line: 9,
    },
  ]

  test('carries config-dir-relative file tokens, pending status, and the project browser label', () => {
    const [flat, nested] = synthesizePlaywrightDiscoveredTests(entries, configDir)

    expect(flat).toMatchObject({
      fileTokens: ['tests', 'a.spec.ts'],
      titlePath: [],
      title: 'flat test',
      browser: 'chromium',
      projectName: 'chromium',
      location: { file: '/proj/tests/a.spec.ts', line: 3, column: 5 },
      provider: 'playwright',
      status: 'pending',
    })
    expect(flat?.id).toBe('discovered:tests/a.spec.ts:chromium:flat test')
    expect(nested).toMatchObject({
      fileTokens: ['tests', 'a.spec.ts'],
      titlePath: ['outer', 'inner'],
      title: 'nested test',
      browser: 'firefox',
      projectName: 'firefox',
      location: { file: '/proj/tests/a.spec.ts', line: 9 },
      provider: 'playwright',
      status: 'pending',
    })
    expect(nested?.id).toBe('discovered:tests/a.spec.ts:firefox:outer > inner > nested test')
  })

  test('projects without a name fall back to the chromium label', () => {
    const [discovered] = synthesizePlaywrightDiscoveredTests(
      [{ file: '/proj/tests/a.spec.ts', titlePath: [], title: 'unnamed', projectName: '', line: 1 }],
      configDir,
    )
    expect(discovered?.browser).toBe('chromium')
    expect(discovered?.id).toBe('discovered:tests/a.spec.ts:chromium:unnamed')
  })

  test('identical entries collapse to one discovered test', () => {
    const discovered = synthesizePlaywrightDiscoveredTests([...entries, ...entries], configDir)
    expect(discovered.length).toBe(2)
  })

  test('a parsed list report synthesizes into the same tree slots streamed results use', () => {
    const discovered = synthesizePlaywrightDiscoveredTests(parsePlaywrightListReport(listReport()), configDir)
    expect(discovered.map(({ id }) => id)).toEqual([
      'discovered:tests/a.spec.ts:chromium:flat test',
      'discovered:tests/a.spec.ts:firefox:flat test',
      'discovered:tests/a.spec.ts:chromium:outer > inner > nested test',
      'discovered:tests/deep/nested.spec.ts:firefox:reaches the bottom',
    ])
    for (const discoveredTest of discovered) {
      expect(discoveredTest.status).toBe('pending')
      expect(discoveredTest.provider).toBe('playwright')
      expect(discoveredTest.id.startsWith('discovered:')).toBe(true)
    }
  })
})

describe('runPlaywrightList', () => {
  const configFile = '/proj/playwright.config.ts'

  test('spawns playwright test --list --reporter=json --config through the local command resolver', async () => {
    const { spawn, calls } = createFakeSpawn({ stdout: JSON.stringify(listReport()) })

    const result = await runPlaywrightList({ configFile, cwd: '/proj', spawn })

    expect(calls.length).toBe(1)
    const call = calls[0]!
    // Package-manager resolution may wrap the binary (npx/bun x); the resolved
    // invocation must still carry the listing command and config.
    const joined = call.args.join(' ')
    expect(joined).toContain('playwright')
    expect(joined).toContain('test')
    expect(joined).toContain('--list')
    expect(joined).toContain('--reporter=json')
    expect(joined).toContain('--config')
    expect(joined).toContain(configFile)
    expect(call.opts.cwd).toBe('/proj')
    const stdio = call.opts.stdio as string[]
    expect(stdio[0]).toBe('ignore')
    const entries = result.ok ? result.entries : []
    expect(entries.map(({ title }) => title)).toEqual(['flat test', 'flat test', 'nested test', 'reaches the bottom'])
  })

  test('a valid report without tests is a successful empty listing', async () => {
    const { spawn } = createFakeSpawn({ stdout: JSON.stringify({ config: { rootDir: ROOT_DIR }, suites: [] }) })
    expect(await runPlaywrightList({ configFile, cwd: '/proj', spawn })).toEqual({ ok: true, entries: [] })
  })

  test('debug mode exports CRVY_RPRTR_DEBUG into the listing spawn environment', async () => {
    const { spawn, calls } = createFakeSpawn({ stdout: JSON.stringify(listReport()) })
    const debug = createDebugLogger({ enabled: true, sink: () => {} })

    const result = await runPlaywrightList({ configFile, cwd: '/proj', spawn, debug })

    expect(result.ok).toBe(true)
    const env = calls[0]!.opts.env as Record<string, string | undefined> | undefined
    expect(env?.CRVY_RPRTR_DEBUG).toBe('1')
  })

  test('debug mode records a failed listing with command, reason, exit code, and stderr', async () => {
    const { spawn } = createFakeSpawn({ stdout: 'not json at all', stderr: 'Error: cannot find module\n', exitCode: 1 })
    const logs: string[] = []
    const debug = createDebugLogger({ enabled: true, sink: (line): void => void logs.push(line) })

    const result = await runPlaywrightList({ configFile, cwd: '/proj', spawn, debug })

    expect(result).toEqual({ ok: false, reason: 'exit' })
    const record = logs.find((line) => line.includes('event=listing-failed'))!
    expect(record).toContain('command=')
    expect(record).toContain('playwright')
    expect(record).toContain('--list')
    expect(record).toContain('cwd=/proj')
    expect(record).toContain('reason=exit')
    expect(record).toContain('exitCode=1')
    expect(record).toContain('Error: cannot find module')
  })

  test('the recorded stderr excerpt is bounded to the tail', async () => {
    const stderr = Array.from({ length: 200 }, (_, index) => `line-${index}-${'x'.repeat(40)}`).join('\n')
    const { spawn } = createFakeSpawn({ stdout: '', stderr, exitCode: 1 })
    const logs: string[] = []
    const debug = createDebugLogger({ enabled: true, sink: (line): void => void logs.push(line) })

    await runPlaywrightList({ configFile, cwd: '/proj', spawn, debug })

    const record = logs.find((line) => line.includes('event=listing-failed'))!
    expect(record).toContain('line-199')
    expect(record).not.toContain('line-0-')
    expect(record.length).toBeLessThan(2600)
  })

  test('with debug off a failed listing records nothing', async () => {
    const { spawn } = createFakeSpawn({ stdout: 'not json at all', stderr: 'boom', exitCode: 1 })
    const logs: string[] = []
    const debug = createDebugLogger({ enabled: false, sink: (line): void => void logs.push(line) })

    await runPlaywrightList({ configFile, cwd: '/proj', spawn, debug })

    expect(logs).toEqual([])
  })

  test('malformed stdout is a parse failure', async () => {
    const { spawn } = createFakeSpawn({ stdout: 'not json at all' })
    expect(await runPlaywrightList({ configFile, cwd: '/proj', spawn })).toEqual({ ok: false, reason: 'parse' })
  })

  test('a non-object report is a parse failure', async () => {
    const { spawn } = createFakeSpawn({ stdout: '[]' })
    expect(await runPlaywrightList({ configFile, cwd: '/proj', spawn })).toEqual({ ok: false, reason: 'parse' })
  })

  test('non-zero exit is a failure even when stdout parses', async () => {
    const { spawn } = createFakeSpawn({ stdout: JSON.stringify(listReport()), exitCode: 1 })
    expect(await runPlaywrightList({ configFile, cwd: '/proj', spawn })).toEqual({ ok: false, reason: 'exit' })
  })

  test('spawn error is a failure', async () => {
    const { spawn } = createFakeSpawn({ emitError: new Error('ENOENT') })
    expect(await runPlaywrightList({ configFile, cwd: '/proj', spawn })).toEqual({ ok: false, reason: 'spawn' })
  })

  test('kill timeout is a failure and kills the listing', async () => {
    const { spawn, calls } = createFakeSpawn({ neverCloses: true })
    const result = await runPlaywrightList({ configFile, cwd: '/proj', spawn, timeoutMs: 5 })
    expect(result).toEqual({ ok: false, reason: 'timeout' })
    expect(calls[0]?.child.killedWith).toBe('SIGKILL')
  })
})

describe('readPlaywrightListWithConfig', () => {
  const summary = {
    webServers: [
      { command: 'npm run storybook', url: 'http://localhost:6006', name: 'storybook', reuseExistingServer: true },
      { command: 'npm run api', port: 4000 },
    ],
    projects: [{ name: 'chromium', baseURL: 'http://localhost:6006' }],
  }

  function dumpOnSpawn(payload: unknown): (args: string[], opts: Record<string, unknown>) => void {
    return (_args, opts) => {
      const target = (opts.env as Record<string, string | undefined> | undefined)?.[DOCKER_CONFIG_DUMP_ENV]
      if (target !== undefined) writeFileSync(target, JSON.stringify(payload))
    }
  }

  test('passes the generated reporter and dump env, then parses both outputs', async () => {
    const { spawn, calls } = createFakeSpawn({ stdout: JSON.stringify(listReport()), onSpawn: dumpOnSpawn(summary) })

    const result = await readPlaywrightListWithConfig('/proj', { spawn })

    const call = calls[0]!
    expect(call.args.join(' ')).toContain(`--reporter=json,${configDumpReporterPath()}`)
    const env = call.opts.env as Record<string, string | undefined>
    // The listing resolves the config as the container will see it.
    expect(env.CRVY_RPRTR_DOCKER).toBe('1')
    expect(env.CRVY_RPRTR_HOST_GATEWAY).toBe('host.docker.internal')
    const dumpPath = env[DOCKER_CONFIG_DUMP_ENV]
    expect(dumpPath).toBeDefined()
    // Read-and-delete: the dump does not survive the listing.
    expect(existsSync(dumpPath!)).toBe(false)
    expect(result.config).toEqual(summary)
    expect(result.report).not.toBeNull()
  })

  test('strips CI so the config resolves as it will inside the container', async () => {
    const { spawn, calls } = createFakeSpawn({ stdout: JSON.stringify(listReport()), onSpawn: dumpOnSpawn(summary) })
    const previous = process.env.CI
    process.env.CI = '1'
    try {
      await readPlaywrightListWithConfig('/proj', { spawn })
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, 'CI')
      else process.env.CI = previous
    }

    const env = calls[0]!.opts.env as Record<string, string | undefined>
    expect('CI' in env).toBe(false)
    expect(env.CRVY_RPRTR_HOST_GATEWAY).toBe('host.docker.internal')
  })

  test('a missing dump degrades to a null summary without losing the report', async () => {
    const { spawn } = createFakeSpawn({ stdout: JSON.stringify(listReport()) })

    const result = await readPlaywrightListWithConfig('/proj', { spawn })

    expect(result.config).toBeNull()
    expect(result.report).not.toBeNull()
  })

  test('a malformed dump degrades to a null summary', async () => {
    const { spawn } = createFakeSpawn({
      stdout: JSON.stringify(listReport()),
      onSpawn: dumpOnSpawn({ webServers: 'not-an-array', projects: [] }),
    })

    expect((await readPlaywrightListWithConfig('/proj', { spawn })).config).toBeNull()
  })
})
