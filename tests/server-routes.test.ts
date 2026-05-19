import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, readFile, rm, writeFile } from 'fs/promises'
import { join } from 'path'

import { handleHttpRequest } from '../src/server/routes'
import type { TestData } from '../src/types'

const TMP_DIR = join(process.cwd(), 'test-approval-routing')
const SCREENSHOT_DIR = join(TMP_DIR, 'screenshots')
const SNAPSHOT_DIR = join(TMP_DIR, 'snapshots')
const PLAYWRIGHT_TEST_DIR = join(TMP_DIR, 'tests')
const TEST_FILE = join(PLAYWRIGHT_TEST_DIR, 'example.spec.ts')
const NESTED_TEST_FILE = join(PLAYWRIGHT_TEST_DIR, 'nested', 'example.spec.ts')
const CUSTOM_TEMPLATE = '{snapshotDir}/{projectName}/{testFilePath}/{arg}{ext}'

function createContext(tests: Record<string, TestData>): Parameters<typeof handleHttpRequest>[0] {
  return {
    reportData: {
      isRunning: false,
      tests,
      browsers: ['chromium'],
      isUpdateMode: false,
      screenshotDir: SCREENSHOT_DIR,
    },
    staticDir: './dist',
    saveReport: async (): Promise<void> => {},
    approvalRouting: {
      configDir: process.cwd(),
      playwrightTestDir: PLAYWRIGHT_TEST_DIR,
      playwrightSnapshotDir: SNAPSHOT_DIR,
      playwrightToHaveScreenshotPathTemplate: CUSTOM_TEMPLATE,
    },
  }
}

afterEach(async () => {
  await rm(TMP_DIR, { recursive: true, force: true })
})

describe('approval routing', () => {
  test('approve writes to the resolver-selected custom-template target', async () => {
    await mkdir(join(SCREENSHOT_DIR, 'test-1'), { recursive: true })
    await mkdir(join(SNAPSHOT_DIR, 'chromium', 'example.spec.ts'), { recursive: true })
    await writeFile(join(SCREENSHOT_DIR, 'test-1', 'header-actual.png'), 'actual image')
    await writeFile(join(SNAPSHOT_DIR, 'chromium', 'example.spec.ts', 'header.png'), 'baseline image')

    const tests: Record<string, TestData> = {
      'test-1': {
        id: 'test-1',
        title: 'visual pass',
        titlePath: ['Suite'],
        browser: 'chromium',
        location: { file: TEST_FILE, line: 10 },
        results: [
          {
            status: 'failed',
            retries: 0,
            images: {
              header: {
                actual: '/screenshots/test-1/header-actual.png',
              },
            },
            visualDeclarations: [
              {
                visualName: 'header',
                kind: 'named',
                declaredName: 'header',
                snapshotBaseName: 'header',
                occurrenceIndex: 1,
              },
            ],
          },
        ],
      },
    }

    const response = await handleHttpRequest(
      createContext(tests),
      new Request('http://localhost/api/approve', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'test-1', retry: 0, image: 'header' }),
      }),
    )

    expect(response.status).toBe(200)
    expect(await readFile(join(SNAPSHOT_DIR, 'chromium', 'example.spec.ts', 'header.png'), 'utf-8')).toBe(
      'actual image',
    )
    expect(tests['test-1']?.approved).toEqual({ header: 0 })
  })

  test('approve uses configured testDir for nested test-file templates', async () => {
    await mkdir(join(SCREENSHOT_DIR, 'test-nested'), { recursive: true })
    await mkdir(join(SNAPSHOT_DIR, 'chromium', 'nested', 'example.spec.ts'), { recursive: true })
    await mkdir(join(SNAPSHOT_DIR, 'chromium', 'example.spec.ts'), { recursive: true })
    await writeFile(join(SCREENSHOT_DIR, 'test-nested', 'header-actual.png'), 'actual image')
    await writeFile(join(SNAPSHOT_DIR, 'chromium', 'nested', 'example.spec.ts', 'header.png'), 'nested baseline image')
    await writeFile(join(SNAPSHOT_DIR, 'chromium', 'example.spec.ts', 'header.png'), 'flat baseline image')

    const tests: Record<string, TestData> = {
      'test-nested': {
        id: 'test-nested',
        title: 'visual pass',
        titlePath: ['Suite'],
        browser: 'chromium',
        location: { file: NESTED_TEST_FILE, line: 10 },
        results: [
          {
            status: 'failed',
            retries: 0,
            images: {
              header: {
                actual: '/screenshots/test-nested/header-actual.png',
              },
            },
            visualDeclarations: [
              {
                visualName: 'header',
                kind: 'named',
                declaredName: 'header',
                snapshotBaseName: 'header',
                occurrenceIndex: 1,
              },
            ],
          },
        ],
      },
    }

    const response = await handleHttpRequest(
      createContext(tests),
      new Request('http://localhost/api/approve', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'test-nested', retry: 0, image: 'header' }),
      }),
    )

    expect(response.status).toBe(200)
    expect(await readFile(join(SNAPSHOT_DIR, 'chromium', 'nested', 'example.spec.ts', 'header.png'), 'utf-8')).toBe(
      'actual image',
    )
    expect(await readFile(join(SNAPSHOT_DIR, 'chromium', 'example.spec.ts', 'header.png'), 'utf-8')).toBe(
      'flat baseline image',
    )
    expect(tests['test-nested']?.approved).toEqual({ header: 0 })
  })

  test('approve fails when exact resolution is ambiguous', async () => {
    await mkdir(join(SCREENSHOT_DIR, 'test-ambiguous'), { recursive: true })
    await mkdir(join(SNAPSHOT_DIR, 'chromium', 'example.spec.ts', 'dir'), { recursive: true })
    await writeFile(join(SCREENSHOT_DIR, 'test-ambiguous', 'dir-header-actual.png'), 'actual image')
    await writeFile(join(SNAPSHOT_DIR, 'chromium', 'example.spec.ts', 'dir-header.png'), 'string baseline')
    await writeFile(join(SNAPSHOT_DIR, 'chromium', 'example.spec.ts', 'dir', 'header.png'), 'array baseline')

    const tests: Record<string, TestData> = {
      'test-ambiguous': {
        id: 'test-ambiguous',
        title: 'visual pass',
        titlePath: ['Suite'],
        browser: 'chromium',
        location: { file: TEST_FILE, line: 10 },
        results: [
          {
            status: 'failed',
            retries: 0,
            images: {
              'dir/header': {
                actual: '/screenshots/test-ambiguous/dir-header-actual.png',
              },
            },
            visualDeclarations: [
              {
                visualName: 'dir/header',
                kind: 'named',
                declaredName: 'dir/header',
                snapshotBaseName: 'dir/header',
                occurrenceIndex: 1,
              },
            ],
          },
        ],
      },
    }

    const response = await handleHttpRequest(
      createContext(tests),
      new Request('http://localhost/api/approve', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'test-ambiguous', retry: 0, image: 'dir/header' }),
      }),
    )

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ success: false, error: 'Could not resolve approval target' })
    expect(await readFile(join(SNAPSHOT_DIR, 'chromium', 'example.spec.ts', 'dir-header.png'), 'utf-8')).toBe(
      'string baseline',
    )
    expect(await readFile(join(SNAPSHOT_DIR, 'chromium', 'example.spec.ts', 'dir', 'header.png'), 'utf-8')).toBe(
      'array baseline',
    )
    expect(tests['test-ambiguous']?.approved).toBeUndefined()
  })

  test('approve-all uses exact resolver targets and skips unresolved images', async () => {
    await mkdir(join(SCREENSHOT_DIR, 'test-success'), { recursive: true })
    await mkdir(join(SCREENSHOT_DIR, 'test-ambiguous'), { recursive: true })
    await mkdir(join(SNAPSHOT_DIR, 'chromium', 'example.spec.ts', 'dir'), { recursive: true })
    await writeFile(join(SCREENSHOT_DIR, 'test-success', 'header-actual.png'), 'actual image')
    await writeFile(join(SCREENSHOT_DIR, 'test-ambiguous', 'dir-header-actual.png'), 'ambiguous actual image')
    await writeFile(join(SNAPSHOT_DIR, 'chromium', 'example.spec.ts', 'header.png'), 'baseline image')
    await writeFile(join(SNAPSHOT_DIR, 'chromium', 'example.spec.ts', 'dir-header.png'), 'string baseline')
    await writeFile(join(SNAPSHOT_DIR, 'chromium', 'example.spec.ts', 'dir', 'header.png'), 'array baseline')

    const tests: Record<string, TestData> = {
      'test-success': {
        id: 'test-success',
        title: 'visual pass',
        titlePath: ['Suite'],
        browser: 'chromium',
        location: { file: TEST_FILE, line: 10 },
        results: [
          {
            status: 'failed',
            retries: 0,
            images: {
              header: {
                actual: '/screenshots/test-success/header-actual.png',
              },
            },
            visualDeclarations: [
              {
                visualName: 'header',
                kind: 'named',
                declaredName: 'header',
                snapshotBaseName: 'header',
                occurrenceIndex: 1,
              },
            ],
          },
        ],
      },
      'test-ambiguous': {
        id: 'test-ambiguous',
        title: 'visual pass',
        titlePath: ['Suite'],
        browser: 'chromium',
        location: { file: TEST_FILE, line: 10 },
        results: [
          {
            status: 'failed',
            retries: 0,
            images: {
              'dir/header': {
                actual: '/screenshots/test-ambiguous/dir-header-actual.png',
              },
            },
            visualDeclarations: [
              {
                visualName: 'dir/header',
                kind: 'named',
                declaredName: 'dir/header',
                snapshotBaseName: 'dir/header',
                occurrenceIndex: 1,
              },
            ],
          },
        ],
      },
    }

    const response = await handleHttpRequest(
      createContext(tests),
      new Request('http://localhost/api/approve-all', { method: 'POST' }),
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ success: true })
    expect(await readFile(join(SNAPSHOT_DIR, 'chromium', 'example.spec.ts', 'header.png'), 'utf-8')).toBe(
      'actual image',
    )
    expect(await readFile(join(SNAPSHOT_DIR, 'chromium', 'example.spec.ts', 'dir-header.png'), 'utf-8')).toBe(
      'string baseline',
    )
    expect(await readFile(join(SNAPSHOT_DIR, 'chromium', 'example.spec.ts', 'dir', 'header.png'), 'utf-8')).toBe(
      'array baseline',
    )
    expect(tests['test-success']?.approved).toEqual({ header: 0 })
    expect(tests['test-ambiguous']?.approved).toBeUndefined()
  })
})
