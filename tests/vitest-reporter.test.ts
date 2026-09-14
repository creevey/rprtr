import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import { WebSocketServer, type WebSocket } from 'ws'

import { attachmentsToImages } from '../src/report-utils'
import {
  OfflineReportSchema,
  RegisterDataSchema,
  RunEndDataSchema,
  TestBeginDataSchema,
  TestEndDataSchema,
  safeParse,
} from '../src/schemas'
import { CrvyRprtrVitestReporter } from '../src/vitest'

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO2G0K0AAAAASUVORK5CYII=',
  'base64',
)

interface MockVitestAttachment {
  readonly contentType: string
  readonly height: number
  readonly name: string
  readonly path: string
  readonly width: number
}

interface MockVitestArtifact {
  readonly attachments: readonly MockVitestAttachment[]
  readonly kind: 'visual-regression'
  readonly message: string
  readonly type: 'internal:toMatchScreenshot'
}

interface MockVitestError {
  readonly message: string
}

interface MockVitestProject {
  readonly config: {
    readonly attachmentsDir?: string
    readonly browser: { readonly screenshotDirectory?: string }
  }
  readonly name: string
}

interface MockVitestCase {
  readonly artifacts: () => readonly MockVitestArtifact[]
  readonly diagnostic: () => { readonly duration: number }
  readonly id: string
  readonly location: { readonly column: number; readonly line: number }
  readonly module: { readonly moduleId: string }
  readonly name: string
  readonly parent: { readonly name: string; readonly parent: { readonly type: 'module' }; readonly type: 'suite' }
  readonly project: MockVitestProject
  readonly result: () => { readonly errors: readonly MockVitestError[]; readonly state: 'failed' | 'passed' }
}

interface CreateTestCaseOptions {
  readonly artifacts?: readonly MockVitestArtifact[]
  readonly errors?: readonly MockVitestError[]
  readonly file: string
  readonly id: string
  readonly name: string
  readonly projectName?: string
  readonly state?: 'failed' | 'passed'
}

function createTestCase(options: CreateTestCaseOptions): MockVitestCase {
  const browser = 'chromium'
  return {
    id: options.id,
    name: options.name,
    location: { line: 7, column: 1 },
    module: { moduleId: options.file },
    parent: { name: 'visual', parent: { type: 'module' }, type: 'suite' },
    project: {
      name: options.projectName ?? browser,
      config: {
        attachmentsDir: join(options.file, '..', '..', '.vitest-attachments'),
        browser: { screenshotDirectory: '__screenshots__' },
      },
    },
    artifacts: (): readonly MockVitestArtifact[] => options.artifacts ?? [],
    result: (): { readonly errors: readonly MockVitestError[]; readonly state: 'failed' | 'passed' } => ({
      state: options.state ?? 'failed',
      errors: options.errors ?? [],
    }),
    diagnostic: (): { readonly duration: number } => ({ duration: 42 }),
  }
}

interface ReporterFixturePaths {
  readonly actualPath: string
  readonly diffPath: string
  readonly referencePath: string
  readonly root: string
  readonly testFile: string
}

async function createFixtureTree(): Promise<ReporterFixturePaths> {
  const root = await mkdtemp(join(tmpdir(), 'crvy-vitest-reporter-'))
  const testFile = join(root, 'tests', 'hero.test.ts')
  const referencePath = join(
    root,
    'tests',
    '__screenshots__',
    'hero.test.ts',
    `hero-section-chromium-${process.platform}.png`,
  )
  const actualPath = join(
    root,
    '.vitest-attachments',
    'tests',
    'hero.test.ts',
    `hero-section-chromium-${process.platform}-actual.png`,
  )
  const diffPath = join(
    root,
    '.vitest-attachments',
    'tests',
    'hero.test.ts',
    `hero-section-chromium-${process.platform}-diff.png`,
  )
  for (const dir of [join(referencePath, '..'), join(actualPath, '..'), join(diffPath, '..')]) {
    await mkdir(dir, { recursive: true })
  }
  await writeFile(referencePath, TINY_PNG)
  await writeFile(actualPath, TINY_PNG)
  await writeFile(diffPath, TINY_PNG)
  return { actualPath, diffPath, referencePath, root, testFile }
}

function mismatchError(paths: { actual: string; diff: string; reference: string }): MockVitestError[] {
  return [
    {
      message: [
        'expect(page.getByTestId("hero")).toMatchScreenshot()',
        '',
        'Screenshot does not match the stored reference.',
        `\nReference screenshot:\n  \u001B[32m${paths.reference}\u001B[39m`,
        `\nActual screenshot:\n  \u001B[31m${paths.actual}\u001B[39m`,
        `\u001B[2m\nDiff image:\n  ${paths.diff}\u001B[22m`,
        '',
      ].join('\n'),
    },
  ]
}

function fixtureErrorPaths(paths: ReporterFixturePaths): { actual: string; diff: string; reference: string } {
  return { actual: paths.actualPath, diff: paths.diffPath, reference: paths.referencePath }
}

function firstRunError(referencePath: string): MockVitestError[] {
  return [
    {
      message: [
        'expect(page.getByTestId("hero")).toMatchScreenshot()',
        '',
        'No existing reference screenshot found; a new one was created. Review it before running tests again.',
        `\nReference screenshot:\n  \u001B[32m${referencePath}\u001B[39m`,
        '',
      ].join('\n'),
    },
  ]
}

interface WsHarness {
  close: () => void
  port: number
  received: Array<Record<string, unknown>>
  waitForCount: (count: number) => Promise<void>
}

function startWsServer(): WsHarness {
  const received: Array<Record<string, unknown>> = []
  const wss = new WebSocketServer({ port: 0 })
  wss.on('connection', (ws: WebSocket) => {
    ws.on('message', (raw) => {
      received.push(JSON.parse((raw as Buffer).toString()) as Record<string, unknown>)
    })
  })
  const address = wss.address()
  if (address === null || typeof address === 'string') throw new Error('unexpected ws address')
  return {
    close: (): void => wss.close(),
    port: address.port,
    received,
    waitForCount: async (count: number): Promise<void> => {
      const deadline = Date.now() + 3000
      while (Date.now() < deadline) {
        if (received.length >= count) return
        await Bun.sleep(25)
      }
      throw new Error(`waitForCount(${count}) timed out; received ${received.length}`)
    },
  }
}

interface ReporterFixture {
  readonly paths: ReporterFixturePaths
  readonly screenshotDir: string
}

async function createReporterFixture(): Promise<ReporterFixture> {
  const paths = await createFixtureTree()
  return { paths, screenshotDir: join(paths.root, 'crvy-screenshots') }
}

function createBrowserInitProject(paths: ReporterFixturePaths): unknown {
  return {
    name: 'chromium',
    config: {
      attachmentsDir: join(paths.root, '.vitest-attachments'),
      browser: { screenshotDirectory: '__screenshots__' },
    },
  }
}

interface MockVitestInit {
  readonly config: { readonly root: string; readonly configFile?: string }
  readonly vite: { readonly config: { readonly configFile?: string } }
}

function createMockVitest(root: string, configFile?: string, viteConfigFile?: string): MockVitestInit {
  return {
    config: configFile === undefined ? { root } : { root, configFile },
    vite: { config: { configFile: viteConfigFile ?? configFile } },
  }
}

type ReceivedEvent = { type: string; data: Record<string, unknown> }

function eventsOfType(received: Array<Record<string, unknown>>, type: string): ReceivedEvent[] {
  return received.filter((message): message is ReceivedEvent => message['type'] === type)
}

const cleanupDirs: string[] = []

afterEach(async () => {
  delete process.env.CI
  await Promise.all(cleanupDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('CrvyRprtrVitestReporter', () => {
  test('dev mode streams renamed native-path attachments and register dirs for a failed comparison', async () => {
    process.env.CI = ''
    const fixture = await createReporterFixture()
    cleanupDirs.push(fixture.paths.root)
    const harness = startWsServer()

    try {
      const reporter = new CrvyRprtrVitestReporter({
        serverUrl: `ws://127.0.0.1:${harness.port}`,
        screenshotDir: fixture.screenshotDir,
      })
      reporter.onInit(createMockVitest(fixture.paths.root) as never)
      reporter.onBrowserInit?.(createBrowserInitProject(fixture.paths) as never)
      await harness.waitForCount(1)

      const testCase = createTestCase({
        id: 'vitest-1',
        name: 'renders hero section',
        file: fixture.paths.testFile,
        artifacts: [
          {
            type: 'internal:toMatchScreenshot',
            kind: 'visual-regression',
            message: 'Screenshot does not match the stored reference.',
            attachments: [
              {
                name: 'reference',
                path: fixture.paths.referencePath,
                contentType: 'image/png',
                width: 100,
                height: 100,
              },
              {
                name: 'actual',
                path: fixture.paths.actualPath,
                contentType: 'image/png',
                width: 100,
                height: 100,
              },
              { name: 'diff', path: fixture.paths.diffPath, contentType: 'image/png', width: 100, height: 100 },
            ],
          },
        ],
        errors: mismatchError(fixtureErrorPaths(fixture.paths)),
      })

      reporter.onTestCaseReady?.(testCase as never)
      reporter.onTestCaseResult?.(testCase as never)
      await harness.waitForCount(3)
      await reporter.onTestRunEnd?.([], [], 'failed')

      const register = RegisterDataSchema.parse(eventsOfType(harness.received, 'register')[0]?.data)
      expect(register.vitestAttachmentsDir).toBe(join(fixture.paths.root, '.vitest-attachments'))
      // References scatter under <any test file dir>/__screenshots__/, so the
      // tightest single allowlist root containing every layout is the vitest root.
      expect(register.vitestReferenceDir).toBe(fixture.paths.root)

      const begin = TestBeginDataSchema.parse(eventsOfType(harness.received, 'test-begin')[0]?.data)
      expect(begin.provider).toBe('vitest')
      expect(begin.browser).toBe('chromium')
      expect(begin.titlePath).toEqual(['visual'])
      expect(begin.location.file).toBe(fixture.paths.testFile)

      const endData = TestEndDataSchema.parse(eventsOfType(harness.received, 'test-end')[0]?.data)
      expect(endData.status).toBe('failed')
      expect(endData.visualNames).toEqual(['hero-section'])
      expect(endData.attachments).toEqual([
        { name: 'hero-section-expected.png', path: fixture.paths.referencePath, contentType: 'image/png' },
        { name: 'hero-section-actual.png', path: fixture.paths.actualPath, contentType: 'image/png' },
        { name: 'hero-section-diff.png', path: fixture.paths.diffPath, contentType: 'image/png' },
      ])
      expect(endData.approvalTargets).toEqual({ 'hero-section': fixture.paths.referencePath })

      const images = attachmentsToImages(endData.attachments)
      const image = images['hero-section']
      expect(image?.source).toBe('comparison')
      expect(image?.expect).toBe(`/file/${encodeURIComponent(fixture.paths.referencePath)}`)
      expect(image?.actual).toBe(`/file/${encodeURIComponent(fixture.paths.actualPath)}`)
      expect(image?.diff).toBe(`/file/${encodeURIComponent(fixture.paths.diffPath)}`)
    } finally {
      harness.close()
    }
  })

  test('dev mode surfaces a first-run reference-only artifact as a baseline-only image', async () => {
    process.env.CI = ''
    const fixture = await createReporterFixture()
    cleanupDirs.push(fixture.paths.root)
    const harness = startWsServer()

    try {
      const reporter = new CrvyRprtrVitestReporter({
        serverUrl: `ws://127.0.0.1:${harness.port}`,
        screenshotDir: fixture.screenshotDir,
      })
      reporter.onInit(createMockVitest(fixture.paths.root) as never)
      reporter.onBrowserInit?.(createBrowserInitProject(fixture.paths) as never)
      await harness.waitForCount(1)

      const testCase = createTestCase({
        id: 'vitest-2',
        name: 'creates baseline on first run',
        file: fixture.paths.testFile,
        artifacts: [
          {
            type: 'internal:toMatchScreenshot',
            kind: 'visual-regression',
            message: 'No existing reference screenshot found; a new one was created.',
            attachments: [
              {
                name: 'reference',
                path: fixture.paths.referencePath,
                contentType: 'image/png',
                width: 100,
                height: 100,
              },
            ],
          },
        ],
        errors: firstRunError(fixture.paths.referencePath),
      })

      reporter.onTestCaseReady?.(testCase as never)
      reporter.onTestCaseResult?.(testCase as never)
      await harness.waitForCount(3)
      await reporter.onTestRunEnd?.([], [], 'failed')

      const endData = TestEndDataSchema.parse(eventsOfType(harness.received, 'test-end')[0]?.data)
      expect(endData.attachments).toEqual([
        { name: 'hero-section-expected.png', path: fixture.paths.referencePath, contentType: 'image/png' },
      ])
      expect(endData.approvalTargets).toEqual({ 'hero-section': fixture.paths.referencePath })

      const image = attachmentsToImages(endData.attachments)['hero-section']
      expect(image?.source).toBe('baseline-only')
      expect(image?.expect).toBe(`/file/${encodeURIComponent(fixture.paths.referencePath)}`)
      expect(image?.actual).toBeUndefined()
      expect(image?.diff).toBeUndefined()
    } finally {
      harness.close()
    }
  })

  test('reconstruction falls back to explicit reference and attachment dirs', async () => {
    process.env.CI = ''
    const fixture = await createReporterFixture()
    cleanupDirs.push(fixture.paths.root)
    const harness = startWsServer()

    try {
      const reporter = new CrvyRprtrVitestReporter({
        serverUrl: `ws://127.0.0.1:${harness.port}`,
        screenshotDir: fixture.screenshotDir,
        referenceDir: 'custom-refs',
        attachmentsDir: 'custom-attachments',
      })
      reporter.onInit(createMockVitest(fixture.paths.root) as never)
      reporter.onBrowserInit?.(createBrowserInitProject(fixture.paths) as never)
      await harness.waitForCount(1)

      // Mismatch artifact whose message carries no screenshot paths and whose
      // attachments lack the reference and diff files, forcing reconstruction.
      const actualAttachmentPath = join(
        fixture.paths.root,
        'custom-attachments',
        'tests',
        'hero.test.ts',
        `hero-section-chromium-${process.platform}-actual.png`,
      )
      await mkdir(join(actualAttachmentPath, '..'), { recursive: true })
      await writeFile(actualAttachmentPath, TINY_PNG)

      const testCase = createTestCase({
        id: 'vitest-3',
        name: 'reconstructs missing roles',
        file: fixture.paths.testFile,
        artifacts: [
          {
            type: 'internal:toMatchScreenshot',
            kind: 'visual-regression',
            message: 'Screenshot does not match the stored reference.',
            attachments: [
              {
                name: 'actual',
                path: actualAttachmentPath,
                contentType: 'image/png',
                width: 100,
                height: 100,
              },
            ],
          },
        ],
        errors: [{ message: 'Screenshot does not match the stored reference.' }],
      })

      reporter.onTestCaseReady?.(testCase as never)
      reporter.onTestCaseResult?.(testCase as never)
      await harness.waitForCount(3)
      await reporter.onTestRunEnd?.([], [], 'failed')

      const register = RegisterDataSchema.parse(eventsOfType(harness.received, 'register')[0]?.data)
      expect(register.vitestAttachmentsDir).toBe(join(fixture.paths.root, 'custom-attachments'))
      // The explicit in-root reference dir is covered by the vitest root allowlist.
      expect(register.vitestReferenceDir).toBe(fixture.paths.root)

      const endData = TestEndDataSchema.parse(eventsOfType(harness.received, 'test-end')[0]?.data)
      const attachmentPaths = new Map(endData.attachments.map((attachment) => [attachment.name, attachment.path]))
      expect(attachmentPaths.get('hero-section-actual.png')).toBe(actualAttachmentPath)
      expect(attachmentPaths.get('hero-section-expected.png')).toBe(
        join(
          fixture.paths.root,
          'tests',
          'custom-refs',
          'hero.test.ts',
          `hero-section-chromium-${process.platform}.png`,
        ),
      )
      expect(attachmentPaths.get('hero-section-diff.png')).toBe(
        join(
          fixture.paths.root,
          'custom-attachments',
          'tests',
          'hero.test.ts',
          `hero-section-chromium-${process.platform}-diff.png`,
        ),
      )
    } finally {
      harness.close()
    }
  })

  test('CI mode writes a schema-valid offline report with portable relative artifacts', async () => {
    const fixture = await createReporterFixture()
    cleanupDirs.push(fixture.paths.root)
    const offlineReportPath = join(fixture.paths.root, 'crvy-rprtr-0.json')
    const reportHtmlPath = join(fixture.paths.root, 'crvy-rprtr.html')

    const reporter = new CrvyRprtrVitestReporter({
      ci: true,
      offlineReportPath,
      reportHtmlPath,
      screenshotDir: fixture.screenshotDir,
      serverUrl: 'ws://127.0.0.1:9',
    })
    reporter.onInit(createMockVitest(fixture.paths.root) as never)
    reporter.onBrowserInit?.(createBrowserInitProject(fixture.paths) as never)

    const testCase = createTestCase({
      id: 'vitest-ci-1',
      name: 'renders hero section',
      file: fixture.paths.testFile,
      artifacts: [
        {
          type: 'internal:toMatchScreenshot',
          kind: 'visual-regression',
          message: 'Screenshot does not match the stored reference.',
          attachments: [
            {
              name: 'reference',
              path: fixture.paths.referencePath,
              contentType: 'image/png',
              width: 100,
              height: 100,
            },
            {
              name: 'actual',
              path: fixture.paths.actualPath,
              contentType: 'image/png',
              width: 100,
              height: 100,
            },
            { name: 'diff', path: fixture.paths.diffPath, contentType: 'image/png', width: 100, height: 100 },
          ],
        },
      ],
      errors: mismatchError(fixtureErrorPaths(fixture.paths)),
    })

    reporter.onTestCaseReady?.(testCase as never)
    reporter.onTestCaseResult?.(testCase as never)
    await reporter.onTestRunEnd?.([], [], 'failed')

    const parsed: unknown = JSON.parse(await readFile(offlineReportPath, 'utf-8'))
    const report = OfflineReportSchema.parse(parsed)
    expect(report.version).toBe(1)
    expect(report.events.map((event) => event.type)).toEqual(['test-begin', 'test-end', 'run-end'])

    const beginData = TestBeginDataSchema.safeParse(report.events[0]?.data)
    expect(beginData.success).toBe(true)
    expect(safeParse(TestBeginDataSchema, report.events[0]?.data)?.provider).toBe('vitest')

    const endData = safeParse(TestEndDataSchema, report.events[1]?.data)
    expect(endData).not.toBeNull()
    expect(safeParse(RunEndDataSchema, report.events[2]?.data)?.status).toBe('failed')

    const attachments = endData?.attachments ?? []
    expect(attachments.map((attachment) => attachment.name).sort()).toEqual([
      'hero-section-actual.png',
      'hero-section-diff.png',
      'hero-section-expected.png',
    ])
    for (const attachment of attachments) {
      expect(attachment.path.includes('/')).toBe(true)
      expect(attachment.path.startsWith(fixture.paths.root)).toBe(false)
    }

    const images = attachmentsToImages(attachments, '/screenshots/')
    const image = images['hero-section']
    expect(image?.source).toBe('comparison')
    expect(image?.actual?.startsWith('/screenshots/')).toBe(true)
    expect(image?.expect?.startsWith('/screenshots/')).toBe(true)
    expect(image?.diff?.startsWith('/screenshots/')).toBe(true)
    expect(
      await Bun.file(join(fixture.screenshotDir, image?.actual?.replace('/screenshots/', '') ?? '')).exists(),
    ).toBe(true)
  })
})

describe('CrvyRprtrVitestReporter register payload', () => {
  test('dev mode register carries runner, cwd, and configFile from the resolved config', async () => {
    process.env.CI = ''
    const fixture = await createReporterFixture()
    cleanupDirs.push(fixture.paths.root)
    const harness = startWsServer()

    try {
      const configFile = join(fixture.paths.root, 'vitest.config.ts')
      const reporter = new CrvyRprtrVitestReporter({
        serverUrl: `ws://127.0.0.1:${harness.port}`,
        screenshotDir: fixture.screenshotDir,
      })
      reporter.onInit(createMockVitest(fixture.paths.root, configFile) as never)
      reporter.onBrowserInit?.(createBrowserInitProject(fixture.paths) as never)
      await harness.waitForCount(1)

      const register = RegisterDataSchema.parse(eventsOfType(harness.received, 'register')[0]?.data)
      expect(register.runner).toBe('vitest')
      expect(register.cwd).toBe(fixture.paths.root)
      expect(register.configFile).toBe(configFile)
      expect(register.vitestAttachmentsDir).toBe(join(fixture.paths.root, '.vitest-attachments'))
      expect(register.vitestReferenceDir).toBe(fixture.paths.root)
    } finally {
      harness.close()
    }
  })

  test('falls back to the vite config when the merged test config hides configFile', async () => {
    process.env.CI = ''
    const fixture = await createReporterFixture()
    cleanupDirs.push(fixture.paths.root)
    const harness = startWsServer()

    try {
      const configFile = join(fixture.paths.root, 'vitest.config.ts')
      const reporter = new CrvyRprtrVitestReporter({
        serverUrl: `ws://127.0.0.1:${harness.port}`,
        screenshotDir: fixture.screenshotDir,
      })
      reporter.onInit(createMockVitest(fixture.paths.root, undefined, configFile) as never)
      reporter.onBrowserInit?.(createBrowserInitProject(fixture.paths) as never)
      await harness.waitForCount(1)

      const register = RegisterDataSchema.parse(eventsOfType(harness.received, 'register')[0]?.data)
      expect(register.configFile).toBe(configFile)
    } finally {
      harness.close()
    }
  })

  test('inline configuration without a config file omits configFile and keeps the payload shape', async () => {
    process.env.CI = ''
    const fixture = await createReporterFixture()
    cleanupDirs.push(fixture.paths.root)
    const harness = startWsServer()

    try {
      const reporter = new CrvyRprtrVitestReporter({
        serverUrl: `ws://127.0.0.1:${harness.port}`,
        screenshotDir: fixture.screenshotDir,
      })
      reporter.onInit(createMockVitest(fixture.paths.root) as never)
      reporter.onBrowserInit?.(createBrowserInitProject(fixture.paths) as never)
      await harness.waitForCount(1)

      const register = RegisterDataSchema.parse(eventsOfType(harness.received, 'register')[0]?.data)
      expect('configFile' in register).toBe(false)
      expect(register.cwd).toBe(fixture.paths.root)
      expect(register.runner).toBe('vitest')
      expect(register.vitestAttachmentsDir).toBe(join(fixture.paths.root, '.vitest-attachments'))
      expect(register.vitestReferenceDir).toBe(fixture.paths.root)
    } finally {
      harness.close()
    }
  })

  test('CI mode sends no register', async () => {
    const fixture = await createReporterFixture()
    cleanupDirs.push(fixture.paths.root)
    const harness = startWsServer()

    try {
      const reporter = new CrvyRprtrVitestReporter({
        ci: true,
        serverUrl: `ws://127.0.0.1:${harness.port}`,
        screenshotDir: fixture.screenshotDir,
        offlineReportPath: join(fixture.paths.root, 'crvy-rprtr-0.json'),
        reportHtmlPath: join(fixture.paths.root, 'crvy-rprtr.html'),
      })
      reporter.onInit(createMockVitest(fixture.paths.root, join(fixture.paths.root, 'vitest.config.ts')) as never)
      reporter.onBrowserInit?.(createBrowserInitProject(fixture.paths) as never)
      await Bun.sleep(150)

      expect(harness.received).toHaveLength(0)
    } finally {
      harness.close()
    }
  })
})

describe('CrvyRprtr Playwright reporter', () => {
  test('emits no approvalTargets field on test-end payloads', async () => {
    const { CrvyRprtr } = await import('../src/reporter')

    const reporter = new CrvyRprtr({
      screenshotDir: join(tmpdir(), 'crvy-playwright-no-targets'),
      reportHtmlPath: join(tmpdir(), 'crvy-playwright-no-targets', 'crvy-rprtr.html'),
      ci: true,
    })

    const sent: unknown[] = []
    type TestReporter = {
      send: (message: unknown) => void
      onTestEnd: (test: object, result: object) => Promise<void>
    }
    const reporterAny = reporter as unknown as TestReporter
    reporterAny.send = (message: unknown): void => {
      sent.push(message)
    }

    await reporterAny.onTestEnd(
      {
        id: 'pw-no-targets',
        title: 'visual',
        location: { file: 'tests/example.spec.ts', line: 10 },
        parent: {
          project: () => ({ name: 'chromium' }),
        },
      },
      { status: 'failed', errors: [], duration: 100, attachments: [], steps: [] },
    )

    const endMessage = sent.find((message): message is { type: string; data: Record<string, unknown> } => {
      const typed = message as { type?: string }
      return typed.type === 'test-end'
    })
    expect(endMessage).toBeDefined()
    expect('approvalTargets' in (endMessage?.data ?? {})).toBe(false)
  })
})
