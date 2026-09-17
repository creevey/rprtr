import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdir, rm, writeFile } from 'fs/promises'
import { join } from 'path'

import {
  discoveredTestIdentity,
  runVitestList,
  synthesizeDiscoveredTests,
  type VitestListEntry,
} from '../src/server/vitest-discovery'
import type { TestData } from '../src/types'

const TMP_ROOT = join(import.meta.dir, 'fixtures', 'vitest-discovery-tmp')

setDefaultTimeout(60000)

interface FakeChild {
  stdout: { on(event: 'data', cb: (chunk: string | Buffer) => void): void }
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
  exitCode?: number | null
  emitError?: Error
  neverCloses?: boolean
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
    return child
  }
  return { spawn, calls }
}

function fixtureStdout(entries: VitestListEntry[]): string {
  return JSON.stringify(entries)
}

async function createTempProject(files: Record<string, string>): Promise<string> {
  const projectDir = join(TMP_ROOT, `project-${process.pid}-${Math.random().toString(36).slice(2, 8)}`)
  for (const [filePath, content] of Object.entries(files)) {
    const absolutePath = join(projectDir, filePath)
    await mkdir(join(absolutePath, '..'), { recursive: true })
    await writeFile(absolutePath, content)
  }
  return projectDir
}

afterEach(async () => {
  await rm(TMP_ROOT, { recursive: true, force: true })
})

describe('runVitestList', () => {
  test('parses fixture entries from stdout', async () => {
    const entries: VitestListEntry[] = [
      { name: 'matches the button baseline', file: '/proj/tests/button.test.ts', projectName: 'chromium' },
      { name: 'expands on click', file: '/proj/tests/expandable.test.ts' },
    ]
    const { spawn, calls } = createFakeSpawn({ stdout: fixtureStdout(entries) })

    const result = await runVitestList({ configFile: '/proj/vitest.config.ts', cwd: '/proj', spawn })

    expect(result).toEqual(entries)
    expect(calls.length).toBe(1)
    const call = calls[0]!
    // Package-manager resolution may wrap the binary (npx/bun x); the resolved
    // invocation must still carry the vitest list command and config.
    const joined = call.args.join(' ')
    expect(joined).toContain('vitest')
    expect(joined).toContain('list')
    expect(joined).toContain('--json')
    expect(joined).toContain('/proj/vitest.config.ts')
    expect(call.opts.cwd).toBe('/proj')
    const env = call.opts.env as Record<string, string | undefined>
    expect(env.CI).toBe('true')
    const stdio = call.opts.stdio as string[]
    expect(stdio[0]).toBe('ignore')
  })

  test('malformed stdout yields an empty list', async () => {
    const { spawn } = createFakeSpawn({ stdout: 'not json at all' })
    const result = await runVitestList({ configFile: '/proj/vitest.config.ts', cwd: '/proj', spawn })
    expect(result).toEqual([])
  })

  test('non-array JSON yields an empty list', async () => {
    const { spawn } = createFakeSpawn({ stdout: '{"name":"nope"}' })
    const result = await runVitestList({ configFile: '/proj/vitest.config.ts', cwd: '/proj', spawn })
    expect(result).toEqual([])
  })

  test('invalid entries are filtered, valid ones kept', async () => {
    const { spawn } = createFakeSpawn({
      stdout: JSON.stringify([
        { name: 'keep me', file: '/proj/tests/a.test.ts', projectName: 'chromium' },
        { file: '/proj/tests/b.test.ts' },
        { name: 42, file: '/proj/tests/c.test.ts' },
      ]),
    })
    const result = await runVitestList({ configFile: '/proj/vitest.config.ts', cwd: '/proj', spawn })
    expect(result).toEqual([{ name: 'keep me', file: '/proj/tests/a.test.ts', projectName: 'chromium' }])
  })

  test('spawn error yields an empty list', async () => {
    const { spawn } = createFakeSpawn({ emitError: new Error('ENOENT') })
    const result = await runVitestList({ configFile: '/proj/vitest.config.ts', cwd: '/proj', spawn })
    expect(result).toEqual([])
  })

  test('kill timeout yields an empty list', async () => {
    const { spawn, calls } = createFakeSpawn({ neverCloses: true, stdout: fixtureStdout([]) })
    const result = await runVitestList({
      configFile: '/proj/vitest.config.ts',
      cwd: '/proj',
      spawn,
      timeoutMs: 5,
    })
    expect(result).toEqual([])
    expect(calls[0]?.child.killedWith).toBe('SIGKILL')
  })

  test('a real vitest project lists its tests', async () => {
    const projectDir = await createTempProject({
      'vitest.config.ts': `import { defineConfig } from 'vitest/config'\nexport default defineConfig({})\n`,
      'src/greeting.test.ts': `import { it } from 'vitest'\nit('greets the world', () => {})\n`,
      'src/nested/deep.test.ts': `import { it } from 'vitest'\nit('reaches the bottom', () => {})\n`,
    })
    const result = await runVitestList({
      configFile: join(projectDir, 'vitest.config.ts'),
      cwd: projectDir,
    })
    const names = result.map((entry) => entry.name).sort()
    expect(names).toEqual(['greets the world', 'reaches the bottom'])
    for (const entry of result) {
      expect(entry.file.startsWith(projectDir)).toBe(true)
    }
  })
})

describe('synthesizeDiscoveredTests', () => {
  const root = '/proj'

  test('flat file entry carries root-relative file tokens with pending status', () => {
    const [discovered] = synthesizeDiscoveredTests(
      [{ name: 'matches the button baseline', file: '/proj/tests/button.test.ts', projectName: 'chromium' }],
      root,
    )
    expect(discovered).toMatchObject({
      fileTokens: ['tests', 'button.test.ts'],
      titlePath: [],
      title: 'matches the button baseline',
      browser: 'chromium',
      projectName: 'chromium',
      status: 'pending',
      provider: 'vitest',
    })
    expect(discovered?.id.startsWith('discovered:')).toBe(true)
  })

  test('nested-directory files carry every directory token', () => {
    const [discovered] = synthesizeDiscoveredTests(
      [{ name: 'reaches the bottom', file: '/proj/src/a/b/deep.test.ts' }],
      root,
    )
    expect(discovered?.fileTokens).toEqual(['src', 'a', 'b', 'deep.test.ts'])
    expect(discovered?.titlePath).toEqual([])
    expect(discovered?.title).toBe('reaches the bottom')
    expect(discovered?.browser).toBe('browser')
  })

  test('suite nesting inside the full name becomes titlePath tokens and a leaf title', () => {
    const [discovered] = synthesizeDiscoveredTests(
      [{ name: 'outer > inner > does the thing', file: '/proj/tests/nested.test.ts', projectName: 'firefox' }],
      root,
    )
    expect(discovered?.fileTokens).toEqual(['tests', 'nested.test.ts'])
    expect(discovered?.titlePath).toEqual(['outer', 'inner'])
    expect(discovered?.title).toBe('does the thing')
    expect(discovered?.browser).toBe('firefox')
  })

  test('identical entries collapse to one discovered test', () => {
    const tests = synthesizeDiscoveredTests(
      [
        { name: 'same name', file: '/proj/tests/a.test.ts', projectName: 'chromium' },
        { name: 'same name', file: '/proj/tests/a.test.ts', projectName: 'chromium' },
      ],
      root,
    )
    expect(tests.length).toBe(1)
  })

  test('different projects keep distinct entries', () => {
    const tests = synthesizeDiscoveredTests(
      [
        { name: 'same name', file: '/proj/tests/a.test.ts', projectName: 'chromium' },
        { name: 'same name', file: '/proj/tests/a.test.ts', projectName: 'firefox' },
      ],
      root,
    )
    expect(tests.length).toBe(2)
    expect(new Set(tests.map(({ browser }) => browser))).toEqual(new Set(['chromium', 'firefox']))
  })

  test('ids carry the discovered: prefix and stay stable for the same entry', () => {
    const entry = { name: 'some test', file: '/proj/tests/a.test.ts', projectName: 'chromium' }
    const [first] = synthesizeDiscoveredTests([entry], root)
    const [second] = synthesizeDiscoveredTests([entry], root)
    expect(first?.id).toBe(second?.id)
    expect(first?.id.startsWith('discovered:')).toBe(true)
  })

  test('identity is (file, full title path) and matches a streamed report test', () => {
    expect(discoveredTestIdentity('/proj/tests/a.test.ts', 'outer > inner > does the thing')).toBe(
      discoveredTestIdentity('/proj/tests/a.test.ts', 'outer > inner > does the thing'),
    )
    expect(discoveredTestIdentity('/proj/tests/a.test.ts', 'a test')).not.toBe(
      discoveredTestIdentity('/proj/tests/b.test.ts', 'a test'),
    )

    const streamed: TestData = {
      id: 'runtime-id',
      titlePath: ['outer', 'inner'],
      title: 'does the thing',
      browser: 'chromium',
      location: { file: '/proj/tests/a.test.ts', line: 3 },
    }
    expect(discoveredTestIdentity('/proj/tests/a.test.ts', 'outer > inner > does the thing')).toBe(
      discoveredTestIdentity(streamed.location?.file ?? '', [...streamed.titlePath, streamed.title].join(' > ')),
    )
  })
})
