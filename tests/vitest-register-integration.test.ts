import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { cp, mkdir, rm, writeFile } from 'fs/promises'
import { join, relative } from 'path'

import { RegisterDataSchema, type RegisterData } from '../src/schemas'
import { createServerApp, type ServerApp } from '../src/server/app'
import { startBunServer } from '../src/server/bun-adapter'

const fixtureDir = join(import.meta.dir, 'fixtures', 'vitest-browser')
// The temp copy stays inside the fixture tree so `@vitest/browser-playwright`
// and `vitest` resolve from the repo root node_modules by walking up.
const tempDir = join(fixtureDir, `register-tmp-${process.pid}`)

setDefaultTimeout(120000)

interface RawMessage {
  type: string
  data: unknown
}

async function createTempFixture(port: number): Promise<string> {
  await rm(tempDir, { recursive: true, force: true })
  await mkdir(tempDir, { recursive: true })
  await cp(join(fixtureDir, 'vitest.integration.browser.test.ts'), join(tempDir, 'vitest.integration.browser.test.ts'))
  await cp(join(fixtureDir, '__screenshots__'), join(tempDir, '__screenshots__'), { recursive: true })

  const reporterImport = relative(tempDir, join(import.meta.dir, '..', 'src', 'vitest.ts')).replaceAll('\\', '/')
  const config = [
    `import { playwright } from '@vitest/browser-playwright'`,
    `import { defineConfig } from 'vitest/config'`,
    ``,
    `import { CrvyRprtrVitestReporter } from './${reporterImport}'`,
    ``,
    `export default defineConfig({`,
    `  root: import.meta.dirname,`,
    `  define: { __HERO_COLOR__: JSON.stringify('#dc2626') },`,
    `  test: {`,
    `    include: ['./vitest.integration.browser.test.ts'],`,
    `    browser: {`,
    `      enabled: true,`,
    `      headless: true,`,
    `      provider: playwright(),`,
    `      instances: [{ browser: 'chromium', viewport: { width: 180, height: 120 } }],`,
    `    },`,
    `    reporters: [new CrvyRprtrVitestReporter({ serverUrl: 'ws://localhost:${port}' })],`,
    `  },`,
    `})`,
    ``,
  ].join('\n')
  const configPath = join(tempDir, 'vitest.register.config.ts')
  await writeFile(configPath, config)
  return configPath
}

interface ServerHarness {
  app: ServerApp
  port: number
  rawMessages: RawMessage[]
  stop: () => Promise<void>
}

async function startServerHarness(screenshotDir: string): Promise<ServerHarness> {
  // Reserve an ephemeral port, then hand it to the server app.
  const probe = Bun.serve({ port: 0, fetch: () => new Response('') })
  const port = probe.port
  await probe.stop(true)
  if (port === undefined) {
    throw new Error('ephemeral port probe returned no port')
  }

  const app = await createServerApp({
    port,
    screenshotDir,
    reportPath: join(screenshotDir, 'report.json'),
    staticDir: './dist',
    // Skip the docker daemon probe; this test exercises the local register path.
    runMode: 'local',
  })

  // Tap raw reporter frames before they reach the handlers so the register
  // payload itself can be asserted against.
  const rawMessages: RawMessage[] = []
  const originalHandle = app.handleWebSocketMessage
  app.handleWebSocketMessage = (message: string): Promise<void> => {
    try {
      const parsed: unknown = JSON.parse(message)
      if (typeof parsed === 'object' && parsed !== null && 'type' in parsed) {
        rawMessages.push(parsed as RawMessage)
      }
    } catch {
      // Non-JSON frames are not expected from the reporter.
    }
    return originalHandle(message)
  }

  const server = startBunServer(app)
  return {
    app,
    port,
    rawMessages,
    stop: async (): Promise<void> => {
      await server.stop(true)
      await app.close()
    },
  }
}

async function waitForRegister(rawMessages: RawMessage[]): Promise<RegisterData> {
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    const register = rawMessages.find((message) => message.type === 'register')
    if (register !== undefined) return RegisterDataSchema.parse(register.data)
    await Bun.sleep(250)
  }
  throw new Error('register message never arrived')
}

async function waitForRunEnabled(port: number): Promise<boolean> {
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    const response = await fetch(`http://localhost:${port}/api/report`)
    const body = (await response.json()) as { runEnabled?: boolean }
    if (body.runEnabled === true) return true
    await Bun.sleep(250)
  }
  return false
}

let harness: ServerHarness | null = null

afterEach(async (): Promise<void> => {
  if (harness !== null) {
    await harness.stop()
    harness = null
  }
  await rm(tempDir, { recursive: true, force: true })
})

describe('Vitest live register', () => {
  test('a real vitest browser run registers runner, configFile, and cwd and enables run triggering', async () => {
    const screenshotDir = join(tempDir, 'server-screenshots')
    harness = await startServerHarness(screenshotDir)
    const { port, rawMessages } = harness
    const configPath = await createTempFixture(port)

    const child = Bun.spawn({
      cmd: ['bunx', 'vitest', 'run', '--config', configPath],
      cwd: tempDir,
      stdout: 'pipe',
      stderr: 'pipe',
      // The register path is non-CI only; never let an outer CI env flip the
      // fixture reporter into offline mode.
      env: { ...process.env, CI: '' },
    })

    try {
      const register = await waitForRegister(rawMessages)
      expect(register.runner).toBe('vitest')
      expect(register.configFile).toBe(configPath)
      expect(register.cwd).toBe(tempDir)

      const runEnabled = await waitForRunEnabled(port)
      expect(runEnabled).toBe(true)
    } finally {
      child.kill()
      await child.exited
      await new Response(child.stdout).text()
      await new Response(child.stderr).text()
    }
  })
})
