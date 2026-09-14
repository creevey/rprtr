import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import { mergeOfflineReportsIntoTests } from '../src/offline-reports'
import { attachmentsToImages } from '../src/report-utils'
import { OfflineReportSchema, TestBeginDataSchema, TestEndDataSchema, safeParse } from '../src/schemas'
import { handleHttpRequest } from '../src/server/routes'
import type { RunController } from '../src/server/run-controller'
import type { TestData } from '../src/types'

const fixtureDir = join(import.meta.dir, 'fixtures', 'vitest-browser')
const outputDir = join(fixtureDir, 'output')
const attachmentsDir = join(fixtureDir, '.vitest-attachments')
const reportPath = join(outputDir, 'crvy-rprtr-0.json')
const testFile = join(fixtureDir, 'vitest.integration.browser.test.ts')
const referenceRelativePath = join(
  '__screenshots__',
  'vitest.integration.browser.test.ts',
  `hero-section-chromium-${process.platform}.png`,
)
const committedReferencePath = join(fixtureDir, referenceRelativePath)

setDefaultTimeout(120000)

let tempFixtureDir: string | null = null

async function cleanupOutputs(): Promise<void> {
  await rm(outputDir, { recursive: true, force: true })
  await rm(attachmentsDir, { recursive: true, force: true })
  if (tempFixtureDir !== null) {
    await rm(tempFixtureDir, { recursive: true, force: true })
    tempFixtureDir = null
  }
}

afterEach(async () => {
  await cleanupOutputs()
})

function createStubRunController(): RunController {
  return {
    start: () => ({ ok: true }),
    stop: () => ({ ok: true }),
    prepareRun: (): Promise<{ ok: true }> => Promise.resolve({ ok: true }),
    dispose: () => {},
    isRunning: false,
  } as unknown as RunController
}

async function spawnFixtureVitestRun(): Promise<void> {
  const child = Bun.spawn({
    cmd: ['bunx', 'vitest', 'run', '--config', join(fixtureDir, 'vitest.config.ts')],
    cwd: fixtureDir,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, VITEST_HERO_COLOR: '#dc2626' },
  })
  expect(await child.exited).toBe(1)
  await new Response(child.stdout).text()
  await new Response(child.stderr).text()
}

describe('Vitest browser integration', () => {
  test('real vitest run produces a schema-valid offline report with screenshot diff artifacts', async () => {
    await cleanupOutputs()
    await spawnFixtureVitestRun()

    const parsed: unknown = JSON.parse(await readFile(reportPath, 'utf-8'))
    const report = OfflineReportSchema.parse(parsed)
    expect(report.version).toBe(1)
    expect(report.events.map((event) => event.type)).toEqual(['test-begin', 'test-end', 'run-end'])

    const begin = safeParse(TestBeginDataSchema, report.events[0]?.data)
    expect(begin).not.toBeNull()
    expect(begin?.provider).toBe('vitest')
    expect(begin?.browser).toBe('chromium')
    expect(begin?.titlePath).toEqual([])
    expect(begin?.location.file).toBe(testFile)
    expect(begin?.location.line).toBe(1)

    const endData = safeParse(TestEndDataSchema, report.events[1]?.data)
    expect(endData).not.toBeNull()
    expect(endData?.status).toBe('failed')
    expect(endData?.visualNames).toEqual(['hero-section'])
    expect(JSON.stringify(endData)).toContain('toMatchScreenshot')
    expect(endData?.approvalTargets).toEqual({ 'hero-section': committedReferencePath })

    const attachmentNames = (endData?.attachments ?? []).map((attachment) => attachment.name).sort()
    expect(attachmentNames).toEqual(['hero-section-actual.png', 'hero-section-diff.png', 'hero-section-expected.png'])

    const images = attachmentsToImages(endData?.attachments ?? [], '/screenshots/')
    const image = images['hero-section']
    expect(image?.source).toBe('comparison')
    expect(image?.expect?.startsWith('/screenshots/')).toBe(true)
    expect(image?.actual?.startsWith('/screenshots/')).toBe(true)
    expect(image?.diff?.startsWith('/screenshots/')).toBe(true)
    expect(image?.expect).not.toBe(image?.actual)

    for (const attachment of endData?.attachments ?? []) {
      expect(attachment.path.startsWith('/')).toBe(false)
      expect(await Bun.file(join(outputDir, 'screenshots', attachment.path)).exists()).toBe(true)
    }
  })

  test('approving the replayed offline report updates a temp fixture reference, never the committed PNG', async () => {
    await cleanupOutputs()
    await spawnFixtureVitestRun()

    const committedBefore = await readFile(committedReferencePath)
    const replaySource: unknown = JSON.parse(await readFile(reportPath, 'utf-8'))
    const runReport = OfflineReportSchema.parse(replaySource)
    const endData = safeParse(TestEndDataSchema, runReport.events[1]?.data)
    expect(endData).not.toBeNull()
    const actualAttachment = endData?.attachments.find((attachment) => attachment.name === 'hero-section-actual.png')
    expect(actualAttachment).toBeDefined()

    // Replay the report against a temp copy of the fixture tree: rewrite every
    // absolute fixture path to the temp root so approval writes land there and
    // the committed reference PNG stays untouched.
    tempFixtureDir = await mkdtemp(join(tmpdir(), 'crvy-vitest-approve-'))
    const tempReferenceDir = join(tempFixtureDir, '__screenshots__', 'vitest.integration.browser.test.ts')
    await mkdir(tempReferenceDir, { recursive: true })
    await copyFile(committedReferencePath, join(tempReferenceDir, `hero-section-chromium-${process.platform}.png`))

    const replayReport = OfflineReportSchema.parse(
      JSON.parse((await readFile(reportPath, 'utf-8')).replaceAll(fixtureDir, tempFixtureDir)) as unknown,
    )
    const replayedTests = mergeOfflineReportsIntoTests({}, [replayReport], {
      screenshotDir: join(outputDir, 'screenshots'),
      screenshotsBaseUrl: '/screenshots/',
    })

    const testId = Object.keys(replayedTests)[0]
    if (testId === undefined) {
      throw new Error('replayed report produced no tests')
    }
    const replayedImage = (replayedTests[testId] as TestData | undefined)?.results?.[0]?.images?.['hero-section']
    const approveFromPath = replayedImage?.approveFromPath
    const approveToPath = replayedImage?.approveToPath
    expect(approveFromPath).toBe(join(outputDir, 'screenshots', actualAttachment?.path ?? ''))
    expect(approveToPath).toBe(join(tempFixtureDir, referenceRelativePath))

    const response = await handleHttpRequest(
      {
        reportData: {
          isRunning: false,
          tests: replayedTests,
          browsers: ['chromium'],
          isUpdateMode: false,
          screenshotDir: join(outputDir, 'screenshots'),
        },
        staticDir: './dist',
        saveReport: async (): Promise<void> => {},
      },
      new Request('http://localhost/api/approve', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: testId, retry: 0, image: 'hero-section' }),
      }),
      createStubRunController(),
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ success: true })
    expect(replayedTests[testId]?.approved).toEqual({ 'hero-section': 0 })

    const approvedActual = await readFile(approveFromPath ?? '')
    expect(await readFile(approveToPath ?? '')).toEqual(approvedActual)

    const committedAfter = await readFile(committedReferencePath)
    expect(committedAfter.equals(committedBefore)).toBe(true)
  })
})
