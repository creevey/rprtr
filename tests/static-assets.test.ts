import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import { handleHttpRequest, type RoutesContext } from '../src/server/routes'
import type { RunController } from '../src/server/run-controller'

function createStubRunController(): RunController {
  return {
    start: () => ({ ok: true }),
    stop: () => ({ ok: true }),
    dispose: () => {},
    isRunning: false,
  } as unknown as RunController
}

describe('Static asset routing', () => {
  let staticDir = ''

  beforeEach(async () => {
    staticDir = await mkdtemp(join(tmpdir(), 'crvy-rprtr-static-assets-'))
    await Bun.write(join(staticDir, 'index.html'), '<!doctype html><title>ok</title>')
    await Bun.write(join(staticDir, 'index.js'), 'console.log("ok");')
  })

  afterEach(async () => {
    if (staticDir !== '') {
      await rm(staticDir, { recursive: true, force: true })
    }
  })

  function createTestContext(): RoutesContext {
    return {
      reportData: {
        isRunning: false,
        tests: {},
        browsers: ['chromium'],
        isUpdateMode: false,
        screenshotDir: './screenshots',
      },
      staticDir,
      saveReport: async () => {},
    }
  }

  test('serves index.html from the resolved static directory', async () => {
    const response = await handleHttpRequest(
      createTestContext(),
      new Request('http://localhost/'),
      createStubRunController(),
    )

    expect(response.status).toBe(200)
    expect(await response.text()).toContain('<title>ok</title>')
  })

  test('serves dist assets from the resolved static directory', async () => {
    const response = await handleHttpRequest(
      createTestContext(),
      new Request('http://localhost/dist/index.js'),
      createStubRunController(),
    )

    expect(response.status).toBe(200)
    expect(await response.text()).toContain('console.log("ok");')
  })
})
