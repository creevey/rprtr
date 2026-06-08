import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, readFile, rm, writeFile } from 'fs/promises'
import { join } from 'path'

import { createServerApp } from '../src/server/app'
import { handleHttpRequest, isPathWithinRoots } from '../src/server/routes'
import type { TestData } from '../src/types'

const TMP_DIR = join(process.cwd(), 'test-approval-routing')
const SCREENSHOT_DIR = join(TMP_DIR, 'screenshots')
const SNAPSHOT_DIR = join(TMP_DIR, 'snapshots')
const PLAYWRIGHT_TEST_DIR = join(TMP_DIR, 'tests')
const TEST_FILE = join(PLAYWRIGHT_TEST_DIR, 'example.spec.ts')
const NESTED_TEST_FILE = join(PLAYWRIGHT_TEST_DIR, 'nested', 'example.spec.ts')
const PLAYWRIGHT_CONFIG_DIR = join(TMP_DIR, 'playwright-config')
const CONFIGURED_PLAYWRIGHT_TEST_DIR = join(PLAYWRIGHT_CONFIG_DIR, 'tests')
const CONFIGURED_NESTED_TEST_FILE = join(CONFIGURED_PLAYWRIGHT_TEST_DIR, 'nested', 'example.spec.ts')
const RELATIVE_SNAPSHOT_DIR = 'test-approval-routing-relative-snapshots'
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
  await rm(join(process.cwd(), RELATIVE_SNAPSHOT_DIR), { recursive: true, force: true })
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

  test('approve resolves relative snapshot paths against the configured configDir instead of the server cwd', async () => {
    const configuredSnapshotDir = join(
      PLAYWRIGHT_CONFIG_DIR,
      RELATIVE_SNAPSHOT_DIR,
      'chromium',
      'nested',
      'example.spec.ts',
    )
    const cwdSnapshotDir = join(process.cwd(), RELATIVE_SNAPSHOT_DIR, 'chromium', 'nested', 'example.spec.ts')
    const reportPath = join(TMP_DIR, 'report.json')

    await mkdir(join(SCREENSHOT_DIR, 'test-config-dir'), { recursive: true })
    await mkdir(configuredSnapshotDir, { recursive: true })
    await mkdir(cwdSnapshotDir, { recursive: true })
    await writeFile(join(SCREENSHOT_DIR, 'test-config-dir', 'header-actual.png'), 'actual image')
    await writeFile(join(configuredSnapshotDir, 'header.png'), 'configured baseline image')
    await writeFile(join(cwdSnapshotDir, 'header.png'), 'cwd baseline image')

    const tests: Record<string, TestData> = {
      'test-config-dir': {
        id: 'test-config-dir',
        title: 'visual pass',
        titlePath: ['Suite'],
        browser: 'chromium',
        location: { file: CONFIGURED_NESTED_TEST_FILE, line: 10 },
        results: [
          {
            status: 'failed',
            retries: 0,
            images: {
              header: {
                actual: '/screenshots/test-config-dir/header-actual.png',
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

    await writeFile(reportPath, JSON.stringify({ tests }))

    const app = await createServerApp({
      reportPath,
      screenshotDir: SCREENSHOT_DIR,
      staticDir: './dist',
      configDir: PLAYWRIGHT_CONFIG_DIR,
      playwrightTestDir: CONFIGURED_PLAYWRIGHT_TEST_DIR,
      playwrightSnapshotDir: RELATIVE_SNAPSHOT_DIR,
      playwrightToHaveScreenshotPathTemplate: CUSTOM_TEMPLATE,
    })

    try {
      const response = await app.handleRequest(
        new Request('http://localhost/api/approve', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: 'test-config-dir', retry: 0, image: 'header' }),
        }),
      )

      expect(response.status).toBe(200)
      expect(await readFile(join(configuredSnapshotDir, 'header.png'), 'utf-8')).toBe('actual image')
      expect(await readFile(join(cwdSnapshotDir, 'header.png'), 'utf-8')).toBe('cwd baseline image')
    } finally {
      app.close()
    }
  })

  test('approve writes an unnamed screenshot to its anonymous baseline target', async () => {
    await mkdir(join(SCREENSHOT_DIR, 'test-unnamed'), { recursive: true })
    await mkdir(join(SNAPSHOT_DIR, 'chromium', 'example.spec.ts'), { recursive: true })
    await writeFile(join(SCREENSHOT_DIR, 'test-unnamed', 'anonymous-actual.png'), 'actual image')
    await writeFile(join(SNAPSHOT_DIR, 'chromium', 'example.spec.ts', 'Suite-visual-pass-1.png'), 'baseline image')

    const tests: Record<string, TestData> = {
      'test-unnamed': {
        id: 'test-unnamed',
        title: 'visual pass',
        titlePath: ['Suite'],
        browser: 'chromium',
        location: { file: TEST_FILE, line: 10 },
        results: [
          {
            status: 'failed',
            retries: 0,
            images: {
              '__unnamed-screenshot-1': {
                actual: '/screenshots/test-unnamed/anonymous-actual.png',
              },
            },
            visualDeclarations: [
              {
                visualName: '__unnamed-screenshot-1',
                kind: 'unnamed',
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
        body: JSON.stringify({ id: 'test-unnamed', retry: 0, image: '__unnamed-screenshot-1' }),
      }),
    )

    expect(response.status).toBe(200)
    expect(await readFile(join(SNAPSHOT_DIR, 'chromium', 'example.spec.ts', 'Suite-visual-pass-1.png'), 'utf-8')).toBe(
      'actual image',
    )
    expect(tests['test-unnamed']?.approved).toEqual({ '__unnamed-screenshot-1': 0 })
  })

  test('approve writes duplicate named screenshots to the matching occurrence target', async () => {
    await mkdir(join(SCREENSHOT_DIR, 'test-duplicate'), { recursive: true })
    await mkdir(join(SNAPSHOT_DIR, 'chromium', 'example.spec.ts'), { recursive: true })
    await writeFile(join(SCREENSHOT_DIR, 'test-duplicate', 'header-1-actual.png'), 'actual image')
    await writeFile(join(SNAPSHOT_DIR, 'chromium', 'example.spec.ts', 'header.png'), 'first baseline image')
    await writeFile(join(SNAPSHOT_DIR, 'chromium', 'example.spec.ts', 'header-1.png'), 'second baseline image')

    const tests: Record<string, TestData> = {
      'test-duplicate': {
        id: 'test-duplicate',
        title: 'visual pass',
        titlePath: ['Suite'],
        browser: 'chromium',
        location: { file: TEST_FILE, line: 10 },
        results: [
          {
            status: 'failed',
            retries: 0,
            images: {
              'header-1': {
                actual: '/screenshots/test-duplicate/header-1-actual.png',
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
              {
                visualName: 'header-1',
                kind: 'named',
                declaredName: 'header',
                snapshotBaseName: 'header',
                occurrenceIndex: 2,
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
        body: JSON.stringify({ id: 'test-duplicate', retry: 0, image: 'header-1' }),
      }),
    )

    expect(response.status).toBe(200)
    expect(await readFile(join(SNAPSHOT_DIR, 'chromium', 'example.spec.ts', 'header.png'), 'utf-8')).toBe(
      'first baseline image',
    )
    expect(await readFile(join(SNAPSHOT_DIR, 'chromium', 'example.spec.ts', 'header-1.png'), 'utf-8')).toBe(
      'actual image',
    )
    expect(tests['test-duplicate']?.approved).toEqual({ 'header-1': 0 })
  })

  test('approve resolves slash-containing names when exactly one candidate exists', async () => {
    await mkdir(join(SCREENSHOT_DIR, 'test-slash'), { recursive: true })
    await mkdir(join(SNAPSHOT_DIR, 'chromium', 'example.spec.ts', 'dir'), { recursive: true })
    await writeFile(join(SCREENSHOT_DIR, 'test-slash', 'dir-header-actual.png'), 'actual image')
    await writeFile(join(SNAPSHOT_DIR, 'chromium', 'example.spec.ts', 'dir', 'header.png'), 'baseline image')

    const tests: Record<string, TestData> = {
      'test-slash': {
        id: 'test-slash',
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
                actual: '/screenshots/test-slash/dir-header-actual.png',
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
        body: JSON.stringify({ id: 'test-slash', retry: 0, image: 'dir/header' }),
      }),
    )

    expect(response.status).toBe(200)
    expect(await readFile(join(SNAPSHOT_DIR, 'chromium', 'example.spec.ts', 'dir', 'header.png'), 'utf-8')).toBe(
      'actual image',
    )
    expect(tests['test-slash']?.approved).toEqual({ 'dir/header': 0 })
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

  test('approve ignores GET and DELETE requests without mutating approval state or files', async () => {
    const assertApproveMethodDoesNotMutate = async (method: 'GET' | 'DELETE'): Promise<void> => {
      const testId = `test-${method.toLowerCase()}`
      const baselinePath = join(SNAPSHOT_DIR, 'chromium', 'example.spec.ts', 'header.png')

      await mkdir(join(SCREENSHOT_DIR, testId), { recursive: true })
      await mkdir(join(SNAPSHOT_DIR, 'chromium', 'example.spec.ts'), { recursive: true })
      await writeFile(join(SCREENSHOT_DIR, testId, 'header-actual.png'), `${method} actual image`)
      await writeFile(baselinePath, `${method} baseline image`)

      const tests: Record<string, TestData> = {
        [testId]: {
          id: testId,
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
                  actual: `/screenshots/${testId}/header-actual.png`,
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
        {
          ...createContext(tests),
          saveReport: (): Promise<void> =>
            Promise.reject(new Error('saveReport should not be called for non-POST approve requests')),
        },
        new Request('http://localhost/api/approve', {
          method,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: testId, retry: 0, image: 'header' }),
        }),
      )

      expect(response.status).toBe(404)
      expect(await readFile(baselinePath, 'utf-8')).toBe(`${method} baseline image`)
      expect(tests[testId]?.approved).toBeUndefined()
    }

    await assertApproveMethodDoesNotMutate('GET')
    await assertApproveMethodDoesNotMutate('DELETE')
  })

  test('approve-all ignores GET requests without mutating approval state or files', async () => {
    await mkdir(join(SCREENSHOT_DIR, 'test-success'), { recursive: true })
    await mkdir(join(SNAPSHOT_DIR, 'chromium', 'example.spec.ts'), { recursive: true })
    await writeFile(join(SCREENSHOT_DIR, 'test-success', 'header-actual.png'), 'actual image')
    await writeFile(join(SNAPSHOT_DIR, 'chromium', 'example.spec.ts', 'header.png'), 'baseline image')

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
    }

    const response = await handleHttpRequest(
      createContext(tests),
      new Request('http://localhost/api/approve-all', { method: 'GET' }),
    )

    expect(response.status).toBe(404)
    expect(await readFile(join(SNAPSHOT_DIR, 'chromium', 'example.spec.ts', 'header.png'), 'utf-8')).toBe(
      'baseline image',
    )
    expect(tests['test-success']?.approved).toBeUndefined()
  })

  test('approve-all reports mixed outcomes and only records approvals for successful copies', async () => {
    await mkdir(join(SCREENSHOT_DIR, 'test-success'), { recursive: true })
    await mkdir(join(SCREENSHOT_DIR, 'test-ambiguous'), { recursive: true })
    await mkdir(join(SCREENSHOT_DIR, 'test-failed'), { recursive: true })
    await mkdir(join(SNAPSHOT_DIR, 'chromium', 'example.spec.ts', 'dir'), { recursive: true })
    await writeFile(join(SCREENSHOT_DIR, 'test-success', 'header-actual.png'), 'actual image')
    await writeFile(join(SCREENSHOT_DIR, 'test-ambiguous', 'dir-header-actual.png'), 'ambiguous actual image')
    await writeFile(join(SNAPSHOT_DIR, 'chromium', 'example.spec.ts', 'header.png'), 'baseline image')
    await writeFile(join(SNAPSHOT_DIR, 'chromium', 'example.spec.ts', 'missing.png'), 'failed baseline')
    await writeFile(join(SNAPSHOT_DIR, 'chromium', 'example.spec.ts', 'dir-header.png'), 'string baseline')
    await writeFile(join(SNAPSHOT_DIR, 'chromium', 'example.spec.ts', 'dir', 'header.png'), 'array baseline')
    await writeFile(join(SNAPSHOT_DIR, 'chromium', 'example.spec.ts', 'no-actual.png'), 'no actual baseline')

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
      'test-failed': {
        id: 'test-failed',
        title: 'visual pass',
        titlePath: ['Suite'],
        browser: 'chromium',
        location: { file: TEST_FILE, line: 10 },
        results: [
          {
            status: 'failed',
            retries: 0,
            images: {
              missing: {
                actual: '/screenshots/test-failed/missing-actual.png',
              },
            },
            visualDeclarations: [
              {
                visualName: 'missing',
                kind: 'named',
                declaredName: 'missing',
                snapshotBaseName: 'missing',
                occurrenceIndex: 1,
              },
            ],
          },
        ],
      },
      'test-no-actual': {
        id: 'test-no-actual',
        title: 'visual pass',
        titlePath: ['Suite'],
        browser: 'chromium',
        location: { file: TEST_FILE, line: 10 },
        results: [
          {
            status: 'failed',
            retries: 0,
            images: {
              'no-actual': {},
            },
            visualDeclarations: [
              {
                visualName: 'no-actual',
                kind: 'named',
                declaredName: 'no-actual',
                snapshotBaseName: 'no-actual',
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
    expect(await response.json()).toEqual({ success: false, approved: 1, unresolved: 2, failed: 1 })
    expect(await readFile(join(SNAPSHOT_DIR, 'chromium', 'example.spec.ts', 'header.png'), 'utf-8')).toBe(
      'actual image',
    )
    expect(await readFile(join(SNAPSHOT_DIR, 'chromium', 'example.spec.ts', 'missing.png'), 'utf-8')).toBe(
      'failed baseline',
    )
    expect(await readFile(join(SNAPSHOT_DIR, 'chromium', 'example.spec.ts', 'dir-header.png'), 'utf-8')).toBe(
      'string baseline',
    )
    expect(await readFile(join(SNAPSHOT_DIR, 'chromium', 'example.spec.ts', 'dir', 'header.png'), 'utf-8')).toBe(
      'array baseline',
    )
    expect(await readFile(join(SNAPSHOT_DIR, 'chromium', 'example.spec.ts', 'no-actual.png'), 'utf-8')).toBe(
      'no actual baseline',
    )
    expect(tests['test-success']?.approved).toEqual({ header: 0 })
    expect(tests['test-ambiguous']?.approved).toBeUndefined()
    expect(tests['test-failed']?.approved).toBeUndefined()
    expect(tests['test-no-actual']?.approved).toBeUndefined()
  })
})

describe('isPathWithinRoots', () => {
  const root = join(process.cwd(), 'allowed')

  test('accepts a file inside an allowed root', () => {
    expect(isPathWithinRoots(join(root, 'sub', 'a.png'), [root])).toBe(true)
  })

  test('accepts the root itself', () => {
    expect(isPathWithinRoots(root, [root])).toBe(true)
  })

  test('rejects a path outside every root', () => {
    expect(isPathWithinRoots(join(process.cwd(), 'other', 'a.png'), [root])).toBe(false)
  })

  test('rejects traversal escaping the root', () => {
    expect(isPathWithinRoots(join(root, '..', 'secret.png'), [root])).toBe(false)
  })
})
