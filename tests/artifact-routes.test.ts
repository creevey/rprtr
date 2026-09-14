import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, rm, writeFile } from 'fs/promises'
import { join } from 'path'

import { createServerApp } from '../src/server/app'

const TMP_DIR = join(process.cwd(), 'test-artifact-routes')
const VITEST_ATTACHMENTS_DIR = join(TMP_DIR, 'vitest', '.vitest-attachments')
const VITEST_REFERENCE_DIR = join(TMP_DIR, 'vitest', '__screenshots__')

async function registerVitestDirs(app: Awaited<ReturnType<typeof createServerApp>>): Promise<void> {
  await app.handleWebSocketMessage(
    JSON.stringify({
      type: 'register',
      data: {
        vitestAttachmentsDir: VITEST_ATTACHMENTS_DIR,
        vitestReferenceDir: VITEST_REFERENCE_DIR,
      },
    }),
  )
}

afterEach(async () => {
  await rm(TMP_DIR, { recursive: true, force: true })
})

describe('vitest artifact directory allowlist', () => {
  test('serves a file inside a registered vitest attachments dir', async () => {
    await mkdir(VITEST_ATTACHMENTS_DIR, { recursive: true })
    await writeFile(join(VITEST_ATTACHMENTS_DIR, 'abc123.png'), 'attachment-bytes')
    const app = await createServerApp({
      screenshotDir: join(TMP_DIR, 'screenshots'),
      reportPath: join(TMP_DIR, 'report.json'),
    })
    await registerVitestDirs(app)

    const res = await app.handleRequest(
      new Request(`http://localhost/file/${encodeURIComponent(join(VITEST_ATTACHMENTS_DIR, 'abc123.png'))}`),
    )
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('attachment-bytes')
  })

  test('serves a file inside a registered vitest reference dir', async () => {
    await mkdir(VITEST_REFERENCE_DIR, { recursive: true })
    await writeFile(join(VITEST_REFERENCE_DIR, 'hero.png'), 'reference-bytes')
    const app = await createServerApp({
      screenshotDir: join(TMP_DIR, 'screenshots'),
      reportPath: join(TMP_DIR, 'report.json'),
    })
    await registerVitestDirs(app)

    const res = await app.handleRequest(
      new Request(`http://localhost/file/${encodeURIComponent(join(VITEST_REFERENCE_DIR, 'hero.png'))}`),
    )
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('reference-bytes')
  })

  test('rejects a file outside every registered root', async () => {
    await mkdir(VITEST_ATTACHMENTS_DIR, { recursive: true })
    await writeFile(join(TMP_DIR, 'outside.png'), 'secret-bytes')
    const app = await createServerApp({
      screenshotDir: join(TMP_DIR, 'screenshots'),
      reportPath: join(TMP_DIR, 'report.json'),
    })
    await registerVitestDirs(app)

    const res = await app.handleRequest(
      new Request(`http://localhost/file/${encodeURIComponent(join(TMP_DIR, 'outside.png'))}`),
    )
    expect(res.status).toBe(404)
  })

  test('rejects vitest dirs before any register call', async () => {
    await mkdir(VITEST_ATTACHMENTS_DIR, { recursive: true })
    await writeFile(join(VITEST_ATTACHMENTS_DIR, 'locked.png'), 'locked-bytes')
    const app = await createServerApp({
      screenshotDir: join(TMP_DIR, 'screenshots'),
      reportPath: join(TMP_DIR, 'report.json'),
    })

    const res = await app.handleRequest(
      new Request(`http://localhost/file/${encodeURIComponent(join(VITEST_ATTACHMENTS_DIR, 'locked.png'))}`),
    )
    expect(res.status).toBe(404)
  })
})
