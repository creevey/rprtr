import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, readFile, rm, writeFile } from 'fs/promises'
import { join } from 'path'

import { handleHttpRequest } from '../src/server/routes'
import type { RunController } from '../src/server/run-controller'
import type { TestData } from '../src/types'

const TMP_DIR = join(process.cwd(), 'test-routes-approve')
const SCREENSHOT_DIR = join(TMP_DIR, 'screenshots')
const NATIVE_DIR = join(TMP_DIR, 'native')
const BASELINE_DIR = join(TMP_DIR, 'baselines')
const SNAPSHOT_DIR = join(TMP_DIR, 'snapshots')
const PLAYWRIGHT_TEST_DIR = join(TMP_DIR, 'tests')
const TEST_FILE = join(PLAYWRIGHT_TEST_DIR, 'example.spec.ts')
const CUSTOM_TEMPLATE = '{snapshotDir}/{projectName}/{testFilePath}/{arg}{ext}'

type RoutesContextArg = Parameters<typeof handleHttpRequest>[0]

function createContext(
  tests: Record<string, TestData>,
  approvalRouting?: RoutesContextArg['approvalRouting'],
): RoutesContextArg {
  return {
    reportData: {
      isRunning: false,
      tests,
      browsers: ['chromium'],
      isUpdateMode: false,
      screenshotDir: SCREENSHOT_DIR,
      environments: {},
    },
    staticDir: './dist',
    saveReport: async (): Promise<void> => {},
    approvalRouting,
  }
}

function createStubRunController(): RunController {
  return {
    start: () => ({ ok: true }),
    stop: () => ({ ok: true }),
    prepareRun: (): Promise<{ ok: true }> => Promise.resolve({ ok: true }),
    dispose: () => {},
    isRunning: false,
  } as unknown as RunController
}

function approveRequest(id: string, image: string): Request {
  return new Request('http://localhost/api/approve', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id, retry: 0, image }),
  })
}

function createMetadataTest(
  id: string,
  images: NonNullable<NonNullable<TestData['results']>[number]['images']>,
): Record<string, TestData> {
  return {
    [id]: {
      id,
      title: 'visual',
      titlePath: ['Suite'],
      browser: 'chromium',
      location: { file: TEST_FILE, line: 10 },
      results: [
        {
          status: 'failed',
          retries: 0,
          images,
        },
      ],
    },
  }
}

afterEach(async () => {
  await rm(TMP_DIR, { recursive: true, force: true })
})

describe('metadata-first approval', () => {
  test('approve copies the metadata source onto the metadata target', async () => {
    await mkdir(NATIVE_DIR, { recursive: true })
    await mkdir(BASELINE_DIR, { recursive: true })
    const sourcePath = join(NATIVE_DIR, 'header-actual.png')
    const targetPath = join(BASELINE_DIR, 'header-chromium-darwin.png')
    await writeFile(sourcePath, 'actual image')
    await writeFile(targetPath, 'stale baseline image')

    const tests = createMetadataTest('test-metadata', {
      header: {
        actual: `/file/${encodeURIComponent(sourcePath)}`,
        approveFromPath: sourcePath,
        approveToPath: targetPath,
      },
    })

    const response = await handleHttpRequest(
      createContext(tests),
      approveRequest('test-metadata', 'header'),
      createStubRunController(),
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ success: true })
    expect(await readFile(targetPath, 'utf-8')).toBe('actual image')
    expect(tests['test-metadata']?.approved).toEqual({ header: 0 })
  })

  test('approve marks a first-run expected-only image approved via the metadata self-copy', async () => {
    await mkdir(BASELINE_DIR, { recursive: true })
    const referencePath = join(BASELINE_DIR, 'hero-chromium-darwin.png')
    await writeFile(referencePath, 'first-run baseline')

    const tests = createMetadataTest('test-first-run', {
      hero: {
        expect: `/file/${encodeURIComponent(referencePath)}`,
        source: 'baseline-only',
        approveFromPath: referencePath,
        approveToPath: referencePath,
      },
    })

    const response = await handleHttpRequest(
      createContext(tests),
      approveRequest('test-first-run', 'hero'),
      createStubRunController(),
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ success: true })
    expect(await readFile(referencePath, 'utf-8')).toBe('first-run baseline')
    expect(tests['test-first-run']?.approved).toEqual({ hero: 0 })
  })

  test('approve-all copies the metadata image and skips a non-approvable sibling', async () => {
    await mkdir(NATIVE_DIR, { recursive: true })
    await mkdir(BASELINE_DIR, { recursive: true })
    const sourcePath = join(NATIVE_DIR, 'header-actual.png')
    const targetPath = join(BASELINE_DIR, 'header-chromium-darwin.png')
    await writeFile(sourcePath, 'actual image')
    await writeFile(targetPath, 'stale baseline image')

    const tests = createMetadataTest('test-mixed', {
      header: {
        actual: `/file/${encodeURIComponent(sourcePath)}`,
        approveFromPath: sourcePath,
        approveToPath: targetPath,
      },
      unknown: {
        source: 'declared-only',
      },
    })

    const response = await handleHttpRequest(
      createContext(tests),
      new Request('http://localhost/api/approve-all', { method: 'POST' }),
      createStubRunController(),
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ success: true, approved: 1, unresolved: 1, failed: 0 })
    expect(await readFile(targetPath, 'utf-8')).toBe('actual image')
    expect(tests['test-mixed']?.approved).toEqual({ header: 0 })
  })
})

describe('resolver fallback', () => {
  test('approve falls back to the snapshot resolver when no metadata is present', async () => {
    await mkdir(join(SCREENSHOT_DIR, 'test-pw'), { recursive: true })
    await mkdir(join(SNAPSHOT_DIR, 'chromium', 'example.spec.ts'), { recursive: true })
    await writeFile(join(SCREENSHOT_DIR, 'test-pw', 'header-actual.png'), 'actual image')
    await writeFile(join(SNAPSHOT_DIR, 'chromium', 'example.spec.ts', 'header.png'), 'baseline image')

    const tests: Record<string, TestData> = {
      'test-pw': {
        id: 'test-pw',
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
                actual: '/screenshots/test-pw/header-actual.png',
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
      createContext(tests, {
        configDir: process.cwd(),
        playwrightTestDir: PLAYWRIGHT_TEST_DIR,
        playwrightSnapshotDir: SNAPSHOT_DIR,
        playwrightToHaveScreenshotPathTemplate: CUSTOM_TEMPLATE,
      }),
      approveRequest('test-pw', 'header'),
      createStubRunController(),
    )

    expect(response.status).toBe(200)
    expect(await readFile(join(SNAPSHOT_DIR, 'chromium', 'example.spec.ts', 'header.png'), 'utf-8')).toBe(
      'actual image',
    )
    expect(tests['test-pw']?.approved).toEqual({ header: 0 })
  })

  test('approve ignores metadata pointing at a missing source and falls back to the resolver', async () => {
    await mkdir(join(SCREENSHOT_DIR, 'test-invalid-meta'), { recursive: true })
    await mkdir(join(SNAPSHOT_DIR, 'chromium', 'example.spec.ts'), { recursive: true })
    await writeFile(join(SCREENSHOT_DIR, 'test-invalid-meta', 'header-actual.png'), 'actual image')
    const metadataTarget = join(BASELINE_DIR, 'header.png')
    await mkdir(BASELINE_DIR, { recursive: true })
    await writeFile(metadataTarget, 'metadata baseline image')
    await writeFile(join(SNAPSHOT_DIR, 'chromium', 'example.spec.ts', 'header.png'), 'resolver baseline image')

    const tests: Record<string, TestData> = {
      'test-invalid-meta': {
        id: 'test-invalid-meta',
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
                actual: '/screenshots/test-invalid-meta/header-actual.png',
                approveFromPath: join(NATIVE_DIR, 'missing-actual.png'),
                approveToPath: metadataTarget,
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
      createContext(tests, {
        configDir: process.cwd(),
        playwrightTestDir: PLAYWRIGHT_TEST_DIR,
        playwrightSnapshotDir: SNAPSHOT_DIR,
        playwrightToHaveScreenshotPathTemplate: CUSTOM_TEMPLATE,
      }),
      approveRequest('test-invalid-meta', 'header'),
      createStubRunController(),
    )

    expect(response.status).toBe(200)
    expect(await readFile(join(SNAPSHOT_DIR, 'chromium', 'example.spec.ts', 'header.png'), 'utf-8')).toBe(
      'actual image',
    )
    expect(await readFile(metadataTarget, 'utf-8')).toBe('metadata baseline image')
    expect(tests['test-invalid-meta']?.approved).toEqual({ header: 0 })
  })
})
