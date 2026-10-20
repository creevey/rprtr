import { describe, expect, test } from 'bun:test'

import type { RunContext } from '../src/server/run-controller'
import {
  buildSpawnEnv,
  createLocalLauncher,
  resolvePlaywrightLaunch,
  type LaunchParams,
} from '../src/server/run-launcher'

const SAMPLE_CTX: RunContext = { configFile: '/proj/playwright.config.ts', cwd: '/proj' }

function params(playwrightArgs: string[]): LaunchParams {
  return { ctx: SAMPLE_CTX, playwrightArgs }
}

describe('buildSpawnEnv', () => {
  test('strips CI and sets reporter URL and HTML_OPEN', () => {
    const env = buildSpawnEnv(3000, { CI: 'true', KEEP_ME: '1' })
    expect(env.CI).toBeUndefined()
    expect(env.KEEP_ME).toBe('1')
    expect(env.CRVY_RPRTR_SERVER_URL).toBe('ws://localhost:3000')
    expect(env.PLAYWRIGHT_HTML_OPEN).toBe('never')
  })

  test('exports the grayscale fontconfig override so browsers inherit it', () => {
    const env = buildSpawnEnv(3000, {}, { platform: 'linux', exists: () => true, writeConfig: () => '/tmp/fonts.conf' })
    expect(env.FONTCONFIG_FILE).toBe('/tmp/fonts.conf')
  })

  test('fontRendering: inherit leaves the environment rendering alone', () => {
    const env = buildSpawnEnv(
      3000,
      {},
      { fontRendering: 'inherit', platform: 'linux', exists: () => true, writeConfig: () => '/tmp/fonts.conf' },
    )
    expect(env.FONTCONFIG_FILE).toBeUndefined()
  })

  test('leaves the environment alone where fontconfig does not apply', () => {
    const env = buildSpawnEnv(3000, {}, { platform: 'darwin', exists: () => true, writeConfig: () => '/tmp/f.conf' })
    expect(env.FONTCONFIG_FILE).toBeUndefined()
  })

  test('defaults to process.env', () => {
    const env = buildSpawnEnv(4100)
    expect(env.CRVY_RPRTR_SERVER_URL).toBe('ws://localhost:4100')
  })
})

function withUserAgent(userAgent: string | undefined, run: () => void): void {
  const saved = process.env.npm_config_user_agent
  try {
    if (userAgent === undefined) delete process.env.npm_config_user_agent
    else process.env.npm_config_user_agent = userAgent
    run()
  } finally {
    if (saved === undefined) delete process.env.npm_config_user_agent
    else process.env.npm_config_user_agent = saved
  }
}

describe('resolvePlaywrightLaunch', () => {
  test('falls back to npx when no package manager is detectable', () => {
    withUserAgent(undefined, () => {
      const result = resolvePlaywrightLaunch('/any/cwd', ['test', '--config', 'x.ts'])
      expect(result.cmd).toBe('npx')
      expect(result.args).toEqual(['playwright', 'test', '--config', 'x.ts'])
    })
  })

  test('resolves berry exec args for a Yarn 4 user agent (no stray --)', () => {
    withUserAgent('yarn/4.13.0 npm/? node/v24.13.0 darwin arm64', () => {
      const result = resolvePlaywrightLaunch('/any/cwd', ['test', '--list', '--reporter=json'])
      expect(result.cmd).toBe('yarn')
      expect(result.args).toEqual(['exec', 'playwright', 'test', '--list', '--reporter=json'])
    })
  })

  test.each([
    ['yarn/1.22.22 npm/? node/v14.17.6 darwin x64', 'yarn', ['exec', 'playwright', '--', 'test', '--config', 'x.ts']],
    ['pnpm/9.12.1 npm/? node/v20.17.0 linux x64', 'pnpm', ['exec', 'playwright', 'test', '--config', 'x.ts']],
    ['pnpm/6.32.9 npm/? node/v14.17.6 darwin x64', 'pnpm', ['exec', 'playwright', 'test', '--config', 'x.ts']],
  ])('keeps existing resolution for %s', (userAgent, cmd, args) => {
    withUserAgent(userAgent, () => {
      const result = resolvePlaywrightLaunch('/any/cwd', ['test', '--config', 'x.ts'])
      expect(result.cmd).toBe(cmd)
      expect(result.args).toEqual(args)
    })
  })
})

describe('createLocalLauncher', () => {
  test('mode is local and available is undefined', () => {
    const launcher = createLocalLauncher({ port: 3000, env: {} })
    expect(launcher.mode).toBe('local')
    expect(launcher.available).toBeUndefined()
  })

  test('launch resolves the command and attaches the spawn env', () => {
    const launcher = createLocalLauncher({
      port: 3000,
      env: { CI: 'true' },
      resolveLaunch: (cwd, args) => ({ cmd: 'pnpm', args: ['exec', 'playwright', ...args] }),
    })
    const spec = launcher.launch(params(['test', '--config', 'x.ts']))
    expect(spec.cmd).toBe('pnpm')
    expect(spec.args).toEqual(['exec', 'playwright', 'test', '--config', 'x.ts'])
    expect(spec.env.CRVY_RPRTR_SERVER_URL).toBe('ws://localhost:3000')
    expect(spec.env.CI).toBeUndefined()
  })

  test('local launches carry no container diagnostics', () => {
    const launcher = createLocalLauncher({ port: 3000, env: {} })
    const spec = launcher.launch(params(['test']))
    expect(spec.container).toBeUndefined()
  })

  test('launch defaults to the package-manager-aware resolver', () => {
    const saved = process.env.npm_config_user_agent
    try {
      delete process.env.npm_config_user_agent
      const launcher = createLocalLauncher({ port: 3000, env: {} })
      const spec = launcher.launch(params(['test']))
      expect(spec.cmd).toBe('npx')
      expect(spec.args).toEqual(['playwright', 'test'])
    } finally {
      if (saved !== undefined) process.env.npm_config_user_agent = saved
    }
  })
})
