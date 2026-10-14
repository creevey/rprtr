import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import { createDebugLogger } from '../src/debug-log'
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

  test('debug mode exports CRVY_RPRTR_DEBUG into the sidecar container', () => {
    const args = buildBrowserSidecarRunArgs({
      ...base,
      debug: createDebugLogger({ enabled: true, sink: () => {} }),
    })
    expect(args).toContain('CRVY_RPRTR_DEBUG=1')
  })

  test('debug mode omits --rm and labels the sidecar container for retention', () => {
    const args = buildBrowserSidecarRunArgs({
      ...base,
      debug: createDebugLogger({ enabled: true, sink: () => {} }),
    })
    expect(args).not.toContain('--rm')
    const labelIndex = args.indexOf('--label')
    expect(labelIndex).toBeGreaterThan(-1)
    expect(args[labelIndex + 1]).toBe('crvy-rprtr.debug=1')
  })

  test('with debug off the sidecar vector keeps --rm and carries no label', () => {
    const args = buildBrowserSidecarRunArgs(base)
    expect(args).toContain('--rm')
    expect(args).not.toContain('--label')
  })

  test('debug mode records the sidecar container details and mount existence', () => {
    const logs: string[] = []
    buildBrowserSidecarRunArgs({
      ...base,
      docker: { platform: 'linux/amd64' },
      fileExists: (path) => path === base.cwd,
      debug: createDebugLogger({ enabled: true, sink: (line): void => void logs.push(line) }),
    })
    const record = logs.find((line) => line.includes('event=container'))!
    expect(record).toContain(`image=${base.image}`)
    expect(record).toContain(`container=${base.containerName}`)
    expect(record).toContain('platform=linux/amd64')
    expect(record).toContain('/proj:exists')
    expect(record).toContain(`${hostFontconfigPath()}:missing`)
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

describe('BrowserSidecar debug preparation records', () => {
  test('records each preparation phase with start and completion', async () => {
    const { exec } = execScript({
      info: ok,
      'image inspect': fail,
      pull: ok,
      'run -d': ok,
      'port crvy-rprtr-browser-1': { exitCode: 0, stdout: '127.0.0.1:49153\n', stderr: '' },
    })
    const logs: string[] = []
    const { sidecar } = sidecarFixture({
      exec,
      debug: createDebugLogger({ enabled: true, sink: (line): void => void logs.push(line) }),
    })

    await sidecar.ensure({ cwd: '/proj' }, noopProgress)

    const phaseLines = logs.filter((line) => line.includes('event=phase'))
    for (const phase of ['daemon-probe', 'image-pull', 'sidecar-start', 'readiness']) {
      expect(phaseLines.some((line) => line.includes(`phase=${phase} status=start`))).toBe(true)
      expect(
        phaseLines.some((line) => line.includes(`phase=${phase} status=completed`) && line.includes('durationMs=')),
      ).toBe(true)
    }
  })

  test('a failed readiness attempt records the phase failure', async () => {
    const { exec } = execScript({
      info: ok,
      'image inspect': ok,
      'run -d': ok,
      'port crvy-rprtr-browser-1': { exitCode: 0, stdout: '127.0.0.1:49153\n', stderr: '' },
    })
    const logs: string[] = []
    const { sidecar } = sidecarFixture({
      exec,
      probeTcp: () => Promise.resolve(false),
      readinessTimeoutMs: 0,
      debug: createDebugLogger({ enabled: true, sink: (line): void => void logs.push(line) }),
    })

    await rejectionOf(sidecar.ensure({ cwd: '/proj' }, noopProgress))

    expect(logs.some((line) => line.includes('phase=readiness status=failed'))).toBe(true)
  })
})

describe('BrowserSidecar failure evidence', () => {
  const failedScript = {
    info: ok,
    'image inspect': ok,
    'run -d': ok,
    'port crvy-rprtr-browser-1': { exitCode: 0, stdout: '127.0.0.1:49153\n', stderr: '' },
    inspect: { exitCode: 0, stdout: 'exited 3 sidecar crashed\n', stderr: '' },
    logs: { exitCode: 0, stdout: 'boom: first\nboom: last\n', stderr: '' },
  }

  function readinessFailureFixture(overrides: Partial<Parameters<typeof createBrowserSidecar>[0]> = {}): {
    calls: string[][]
    logs: string[]
    sidecar: ReturnType<typeof createBrowserSidecar>
  } {
    const { exec, calls } = execScript(failedScript)
    const logs: string[] = []
    const sidecar = sidecarFixture({
      exec,
      probeTcp: () => Promise.resolve(false),
      readinessTimeoutMs: 0,
      log: (line): void => void logs.push(line),
      ...overrides,
    }).sidecar
    return { calls, logs, sidecar }
  }

  test('a readiness failure records image, name, inspect state, and a log tail before removal', async () => {
    const { calls, logs, sidecar } = readinessFailureFixture()

    const error = await rejectionOf(sidecar.ensure({ cwd: '/proj' }, noopProgress))
    expect(error).toBeInstanceOf(DockerUnavailableError)

    const record = logs.find((line) => line.includes('event=sidecar-failed'))!
    expect(record).toContain('image=mcr.microsoft.com/playwright:v1.59.0-noble')
    expect(record).toContain('container=crvy-rprtr-browser-1')
    expect(record).toContain('docker inspect crvy-rprtr-browser-1')
    expect(record).toContain('docker logs --tail 50 crvy-rprtr-browser-1')
    expect(record).toContain('state=exited')
    expect(record).toContain('exitCode=3')
    expect(record).toContain('error="sidecar crashed"')
    expect(record).toContain('boom: last')

    const runIndex = calls.findIndex((call) => call[0] === 'run')
    const inspectIndex = calls.findIndex((call, index) => index > runIndex && call[0] === 'inspect')
    const rmIndex = calls.findIndex((call, index) => index > runIndex && call[0] === 'rm')
    expect(inspectIndex).toBeGreaterThan(-1)
    expect(rmIndex).toBeGreaterThan(-1)
    expect(inspectIndex).toBeLessThan(rmIndex)
  })

  test('debug mode retains the failed sidecar and records the inspection commands', async () => {
    const debugLogs: string[] = []
    const { calls, logs, sidecar } = readinessFailureFixture({
      debug: createDebugLogger({ enabled: true, sink: (line): void => void debugLogs.push(line) }),
    })

    await rejectionOf(sidecar.ensure({ cwd: '/proj' }, noopProgress))

    expect(logs).toEqual([])
    const record = debugLogs.find((line) => line.includes('event=sidecar-failed'))!
    expect(record).toContain('container=crvy-rprtr-browser-1')
    expect(record).toContain('docker inspect crvy-rprtr-browser-1')
    expect(record).toContain('docker logs --tail 50 crvy-rprtr-browser-1')
    const runIndex = calls.findIndex((call) => call[0] === 'run')
    expect(calls.findIndex((call, index) => index > runIndex && call[0] === 'rm')).toBe(-1)
  })

  test('an already-removed container still fails as docker-unavailable', async () => {
    const { exec, calls } = execScript({
      info: ok,
      'image inspect': ok,
      'run -d': ok,
      'port crvy-rprtr-browser-1': { exitCode: 0, stdout: '127.0.0.1:49153\n', stderr: '' },
      inspect: fail,
      logs: fail,
    })
    const logs: string[] = []
    const { sidecar } = sidecarFixture({
      exec,
      probeTcp: () => Promise.resolve(false),
      readinessTimeoutMs: 0,
      log: (line): void => void logs.push(line),
    })

    const error = await rejectionOf(sidecar.ensure({ cwd: '/proj' }, noopProgress))
    expect(error).toBeInstanceOf(DockerUnavailableError)

    const record = logs.find((line) => line.includes('event=sidecar-failed'))!
    expect(record).toContain('container=crvy-rprtr-browser-1')
    expect(record).not.toContain('state=')
    expect(record).not.toContain('logTail=')
    expect(calls).toContainEqual(['rm', '-f', 'crvy-rprtr-browser-1'])
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

describe('BrowserSidecar image provenance', () => {
  test('resolveImage derives the canonical tag from the project version', () => {
    const { sidecar } = sidecarFixture({})
    expect(sidecar.resolveImage({ cwd: '/proj' })).toBe('mcr.microsoft.com/playwright:v1.59.0-noble')
  })

  test('resolveImage honors an explicit docker image', () => {
    const { sidecar } = sidecarFixture({ docker: { image: 'custom/pw:1' } })
    expect(sidecar.resolveImage({ cwd: '/proj' })).toBe('custom/pw:1')
  })

  test('resolveImage is null without a version or explicit image', () => {
    const { sidecar } = sidecarFixture({ getPlaywrightVersion: () => null, docker: {} })
    expect(sidecar.resolveImage({ cwd: '/proj' })).toBeNull()
  })

  test('exposes the started image and clears it on dispose', async () => {
    const { exec } = execScript({
      info: ok,
      'image inspect': ok,
      'run -d': ok,
      'port crvy-rprtr-browser-1': { exitCode: 0, stdout: '127.0.0.1:49153\n', stderr: '' },
    })
    const { sidecar } = sidecarFixture({ exec })
    expect(sidecar.image).toBeUndefined()

    await sidecar.ensure({ cwd: '/proj' }, noopProgress)
    expect(sidecar.image).toBe('mcr.microsoft.com/playwright:v1.59.0-noble')

    sidecar.dispose()
    expect(sidecar.image).toBeUndefined()
  })
})
