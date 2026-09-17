import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import { BROWSER_SIDECAR_PORT, createBrowserSidecar, hasBrowserEndpointHook } from '../src/server/browser-sidecar'
import { buildBrowserSidecarRunArgs, resolveSidecarCommand } from '../src/server/docker-run-args'
import { DockerUnavailableError, type DockerExec, type DockerExecResult } from '../src/server/docker-support'
import { CONTAINER_FONTCONFIG_PATH, GRAYSCALE_FONTCONFIG_XML, hostFontconfigPath } from '../src/server/fontconfig'

const tempDirs: string[] = []

async function writeConfig(source: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'crvy-browser-sidecar-'))
  tempDirs.push(dir)
  const path = join(dir, 'vitest.config.ts')
  await writeFile(path, source)
  return path
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('hasBrowserEndpointHook', () => {
  test('finds the documented env var reference', async () => {
    const path = await writeConfig(
      `provider: playwright({ connectOptions: process.env.CRVY_RPRTR_BROWSER_WS ? { wsEndpoint: process.env.CRVY_RPRTR_BROWSER_WS } : undefined }),\n`,
    )
    expect(hasBrowserEndpointHook(path)).toBe(true)
  })

  test('returns false for a config without the env var', async () => {
    const path = await writeConfig(`export default { test: { browser: { enabled: true } } }\n`)
    expect(hasBrowserEndpointHook(path)).toBe(false)
  })

  test('returns false for a missing config file', () => {
    expect(hasBrowserEndpointHook('/definitely/missing/vitest.config.ts')).toBe(false)
  })
})

describe('buildBrowserSidecarRunArgs', () => {
  const base = {
    cwd: '/proj',
    image: 'mcr.microsoft.com/playwright:v1.59.0-noble',
    containerName: 'crvy-rprtr-browser-123',
    command: ['node', '/work/node_modules/playwright/cli.js'],
    port: BROWSER_SIDECAR_PORT,
  }

  test('builds a detached, loopback-published, read-only-mount run-server container', async () => {
    const args = buildBrowserSidecarRunArgs(base)
    expect(args).toEqual([
      'run',
      '-d',
      '--rm',
      '--init',
      '--ipc=host',
      '--name',
      'crvy-rprtr-browser-123',
      '-p',
      '127.0.0.1::6677',
      '-v',
      `${hostFontconfigPath()}:${CONTAINER_FONTCONFIG_PATH}:ro`,
      '-v',
      '/proj:/work:ro',
      '-e',
      'TZ=UTC',
      '-e',
      'LANG=C.UTF-8',
      '-e',
      'LC_ALL=C.UTF-8',
      'mcr.microsoft.com/playwright:v1.59.0-noble',
      'node',
      '/work/node_modules/playwright/cli.js',
      'run-server',
      '--port',
      '6677',
      '--host',
      '0.0.0.0',
    ])
    // Docker turns a missing bind source into a directory, which would mount garbage into conf.d.
    expect(await Bun.file(hostFontconfigPath()).text()).toBe(GRAYSCALE_FONTCONFIG_XML)
  })

  test('omits the fontconfig drop-in when rendering is inherited', () => {
    const args = buildBrowserSidecarRunArgs({ ...base, docker: { fontRendering: 'inherit' } })
    expect(args.some((arg) => arg.includes(CONTAINER_FONTCONFIG_PATH))).toBe(false)
  })

  test('includes --platform only when configured', () => {
    expect(buildBrowserSidecarRunArgs(base)).not.toContain('--platform')
    const args = buildBrowserSidecarRunArgs({ ...base, docker: { platform: 'linux/amd64' } })
    const idx = args.indexOf('--platform')
    expect(idx).toBeGreaterThan(-1)
    expect(args[idx + 1]).toBe('linux/amd64')
    expect(idx).toBeLessThan(args.indexOf(base.image))
  })
})

describe('resolveSidecarCommand', () => {
  test('uses the project playwright CLI when present', () => {
    const command = resolveSidecarCommand({
      cwd: '/proj',
      version: '1.59.0',
      fileExists: (path) => path === join('/proj', 'node_modules', 'playwright', 'cli.js'),
    })
    expect(command).toEqual(['node', '/work/node_modules/playwright/cli.js'])
  })

  test('falls back to the @playwright/test CLI', () => {
    const command = resolveSidecarCommand({
      cwd: '/proj',
      version: '1.59.0',
      fileExists: (path) => path === join('/proj', 'node_modules', '@playwright', 'test', 'cli.js'),
    })
    expect(command).toEqual(['node', '/work/node_modules/@playwright/test/cli.js'])
  })

  test('falls back to a version-pinned npx when the project has no local CLI', () => {
    const command = resolveSidecarCommand({ cwd: '/proj', version: '1.59.0', fileExists: () => false })
    expect(command).toEqual(['npx', '-y', 'playwright@1.59.0'])
  })

  test('falls back to unpinned npx when no version resolves', () => {
    const command = resolveSidecarCommand({ cwd: '/proj', version: null, fileExists: () => false })
    expect(command).toEqual(['npx', '-y', 'playwright'])
  })
})

const ok: DockerExecResult = { exitCode: 0, stdout: '', stderr: '' }
const fail: DockerExecResult = { exitCode: 1, stdout: '', stderr: 'no' }
const noopProgress = (): void => {}

function execScript(handlers: Record<string, DockerExecResult>): { exec: DockerExec; calls: string[][] } {
  const calls: string[][] = []
  const exec: DockerExec = (args) => {
    calls.push(args)
    const key = args.slice(0, 2).join(' ')
    return Promise.resolve(handlers[key] ?? handlers[args[0]!] ?? fail)
  }
  return { exec, calls }
}

function sidecarFixture(overrides: Partial<Parameters<typeof createBrowserSidecar>[0]> = {}): {
  sidecar: ReturnType<typeof createBrowserSidecar>
  calls: string[][]
} {
  const { exec, calls } = overrides.exec === undefined ? execScript({}) : { exec: overrides.exec, calls: [] }
  const sidecar = createBrowserSidecar({
    exec,
    containerName: 'crvy-rprtr-browser-1',
    getPlaywrightVersion: () => '1.59.0',
    fileExists: () => true,
    probeTcp: () => Promise.resolve(true),
    sleep: () => Promise.resolve(),
    ...overrides,
  })
  return { sidecar, calls }
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('Expected promise to reject, but it resolved')
}

describe('BrowserSidecar.ensure', () => {
  test('starts a sidecar container and resolves the published endpoint', async () => {
    const { exec, calls } = execScript({
      info: ok,
      'image inspect': ok,
      'run -d': ok,
      'port crvy-rprtr-browser-1': { exitCode: 0, stdout: '127.0.0.1:49153\n', stderr: '' },
    })
    const { sidecar } = sidecarFixture({ exec })
    const phases: string[] = []
    const endpoint = await sidecar.ensure({ cwd: '/proj' }, (phase) => phases.push(phase))
    expect(endpoint).toBe('ws://127.0.0.1:49153/')
    expect(sidecar.endpoint).toBe('ws://127.0.0.1:49153/')
    expect(phases).toEqual(['starting-sidecar'])
    const runArgs = calls.find((call) => call[0] === 'run')!
    expect(runArgs).toContain('crvy-rprtr-browser-1')
    expect(runArgs).toContain('127.0.0.1::6677')
    expect(runArgs).toContain('mcr.microsoft.com/playwright:v1.59.0-noble')
    expect(runArgs).toContain('run-server')
  })

  test('pulls a missing image with a pulling phase', async () => {
    const { exec } = execScript({
      info: ok,
      'image inspect': fail,
      pull: ok,
      'run -d': ok,
      'port crvy-rprtr-browser-1': { exitCode: 0, stdout: '127.0.0.1:49153\n', stderr: '' },
    })
    const { sidecar } = sidecarFixture({ exec })
    const phases: string[] = []
    await sidecar.ensure({ cwd: '/proj' }, (phase) => phases.push(phase))
    expect(phases).toEqual(['pulling', 'starting-sidecar'])
  })

  test('reuses a warm ready sidecar without starting a new container', async () => {
    const { exec, calls } = execScript({
      info: ok,
      'image inspect': ok,
      'run -d': ok,
      'port crvy-rprtr-browser-1': { exitCode: 0, stdout: '127.0.0.1:49153\n', stderr: '' },
    })
    const { sidecar } = sidecarFixture({ exec })
    await sidecar.ensure({ cwd: '/proj' }, noopProgress)
    calls.length = 0
    const endpoint = await sidecar.ensure({ cwd: '/proj' }, noopProgress)
    expect(endpoint).toBe('ws://127.0.0.1:49153/')
    expect(calls.some((call) => call[0] === 'run')).toBe(false)
  })

  test('restarts the sidecar when the warm endpoint no longer answers', async () => {
    const { exec, calls } = execScript({
      info: ok,
      'image inspect': ok,
      'run -d': ok,
      'port crvy-rprtr-browser-1': { exitCode: 0, stdout: '127.0.0.1:49153\n', stderr: '' },
    })
    const probeResults = [true, false, true]
    const { sidecar } = sidecarFixture({ exec, probeTcp: () => Promise.resolve(probeResults.shift() ?? true) })
    await sidecar.ensure({ cwd: '/proj' }, noopProgress)
    calls.length = 0
    const endpoint = await sidecar.ensure({ cwd: '/proj' }, noopProgress)
    expect(endpoint).toBe('ws://127.0.0.1:49153/')
    expect(calls.filter((call) => call[0] === 'run')).toHaveLength(1)
    expect(calls).toContainEqual(['rm', '-f', 'crvy-rprtr-browser-1'])
  })

  test('fails with DockerUnavailableError when the daemon is down', async () => {
    const { exec } = execScript({ info: fail })
    const { sidecar } = sidecarFixture({ exec })
    const error = await rejectionOf(sidecar.ensure({ cwd: '/proj' }, noopProgress))
    expect(error).toBeInstanceOf(DockerUnavailableError)
  })

  test('fails and removes the container when the endpoint never becomes ready', async () => {
    const { exec, calls } = execScript({
      info: ok,
      'image inspect': ok,
      'run -d': ok,
      'port crvy-rprtr-browser-1': { exitCode: 0, stdout: '127.0.0.1:49153\n', stderr: '' },
    })
    const { sidecar } = sidecarFixture({ exec, probeTcp: () => Promise.resolve(false), readinessTimeoutMs: 0 })
    const error = await rejectionOf(sidecar.ensure({ cwd: '/proj' }, noopProgress))
    expect(error).toBeInstanceOf(DockerUnavailableError)
    expect(sidecar.endpoint).toBeUndefined()
    expect(calls).toContainEqual(['rm', '-f', 'crvy-rprtr-browser-1'])
  })

  test('fails when the image cannot be resolved', async () => {
    const { exec, calls } = execScript({ info: ok })
    const { sidecar } = sidecarFixture({ exec, getPlaywrightVersion: () => null, docker: {} })
    const error = await rejectionOf(sidecar.ensure({ cwd: '/proj' }, noopProgress))
    expect((error as Error).message).toContain('docker.image')
    expect(calls.some((call) => call[0] === 'run')).toBe(false)
  })

  test('an explicit docker image wins without a resolvable version', async () => {
    const { exec, calls } = execScript({
      info: ok,
      'image inspect': ok,
      'run -d': ok,
      'port crvy-rprtr-browser-1': { exitCode: 0, stdout: '127.0.0.1:49153\n', stderr: '' },
    })
    const { sidecar } = sidecarFixture({ exec, getPlaywrightVersion: () => null, docker: { image: 'custom/pw:1' } })
    const endpoint = await sidecar.ensure({ cwd: '/proj' }, noopProgress)
    expect(endpoint).toBe('ws://127.0.0.1:49153/')
    const runArgs = calls.find((call) => call[0] === 'run')!
    expect(runArgs).toContain('custom/pw:1')
    expect(runArgs).not.toContain('mcr.microsoft.com/playwright:v1.59.0-noble')
  })

  test('defaults the container name to the server PID', async () => {
    const { exec, calls } = execScript({
      info: ok,
      'image inspect': ok,
      'run -d': ok,
      [`port crvy-rprtr-browser-${process.pid}`]: { exitCode: 0, stdout: '127.0.0.1:49153\n', stderr: '' },
    })
    const sidecar = createBrowserSidecar({
      exec,
      getPlaywrightVersion: () => '1.59.0',
      fileExists: () => true,
      probeTcp: () => Promise.resolve(true),
    })
    await sidecar.ensure({ cwd: '/proj' }, noopProgress)
    expect(calls.find((call) => call[0] === 'run')).toContain(`crvy-rprtr-browser-${process.pid}`)
  })
})

describe('BrowserSidecar.dispose', () => {
  test('removes the warm container and clears the endpoint', async () => {
    const { exec, calls } = execScript({
      info: ok,
      'image inspect': ok,
      'run -d': ok,
      'port crvy-rprtr-browser-1': { exitCode: 0, stdout: '127.0.0.1:49153\n', stderr: '' },
    })
    const { sidecar } = sidecarFixture({ exec })
    await sidecar.ensure({ cwd: '/proj' }, noopProgress)
    sidecar.dispose()
    await Promise.resolve()
    expect(calls).toContainEqual(['rm', '-f', 'crvy-rprtr-browser-1'])
    expect(sidecar.endpoint).toBeUndefined()
  })
})
