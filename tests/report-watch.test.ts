import { afterEach, describe, expect, mock, test } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import { createServerApp } from '../src/server/app'
import { createDebouncedRefresh } from '../src/server/report-watch'

describe('report-watch', () => {
  const cleanupPaths: string[] = []

  interface SyncMessage {
    type: string
    data?: {
      isUpdateMode?: boolean
      tests?: Record<string, { id?: string; title?: string }>
    }
  }

  afterEach(async () => {
    await Promise.all(
      cleanupPaths.splice(0).map(async (path): Promise<void> => {
        await rm(path, { recursive: true, force: true })
      }),
    )
  })

  test('coalesces rapid refresh requests into one reload', async () => {
    const reload = mock(async (): Promise<void> => {})
    const refresh = createDebouncedRefresh(reload, 25)

    refresh()
    refresh()
    refresh()

    await Bun.sleep(60)

    expect(reload).toHaveBeenCalledTimes(1)
  })

  test('broadcasts sync after report.json changes on disk', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'crvy-rprtr-report-watch-'))
    cleanupPaths.push(tempDir)

    const reportPath = join(tempDir, 'report.json')
    const screenshotDir = join(tempDir, 'screenshots')
    await mkdir(screenshotDir, { recursive: true })
    await writeFile(join(tempDir, 'index.html'), '<!doctype html><title>test</title>')
    await writeFile(reportPath, JSON.stringify({ tests: {}, isUpdateMode: false }))

    const app = await createServerApp({
      reportPath,
      screenshotDir,
      staticDir: tempDir,
    })

    const messages: unknown[] = []
    const wsClient = {
      send(message: string): void {
        messages.push(JSON.parse(message) as unknown)
      },
    }

    app.wsClients.add(wsClient)

    await writeFile(
      reportPath,
      JSON.stringify({
        tests: {
          'test-1': {
            id: 'test-1',
            title: 'visual pass',
            titlePath: ['Suite'],
            browser: 'chromium',
            results: [],
          },
        },
        isUpdateMode: true,
      }),
    )

    await Bun.sleep(250)
    app.close()

    const syncMessage = messages.find(
      (message): message is SyncMessage =>
        typeof message === 'object' && message !== null && 'type' in message && message.type === 'sync',
    )

    expect(syncMessage).toBeDefined()
    expect(syncMessage?.data?.isUpdateMode).toBe(true)
    expect(syncMessage?.data?.tests?.['test-1']?.id).toBe('test-1')
    expect(syncMessage?.data?.tests?.['test-1']?.title).toBe('visual pass')
  })
})
