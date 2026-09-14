import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { readFile, rm } from 'fs/promises'
import { join } from 'path'

import { attachmentsToImages } from '../src/report-utils'
import { OfflineReportSchema, TestBeginDataSchema, TestEndDataSchema, safeParse } from '../src/schemas'

const fixtureDir = join(import.meta.dir, 'fixtures', 'vitest-browser')
const outputDir = join(fixtureDir, 'output')
const attachmentsDir = join(fixtureDir, '.vitest-attachments')
const reportPath = join(outputDir, 'crvy-rprtr-0.json')
const testFile = join(fixtureDir, 'vitest.integration.browser.test.ts')

setDefaultTimeout(120000)

async function cleanupOutputs(): Promise<void> {
  await rm(outputDir, { recursive: true, force: true })
  await rm(attachmentsDir, { recursive: true, force: true })
}

afterEach(async () => {
  await cleanupOutputs()
})

describe('Vitest browser integration', () => {
  test('real vitest run produces a schema-valid offline report with screenshot diff artifacts', async () => {
    await cleanupOutputs()

    const child = Bun.spawn({
      cmd: ['bunx', 'vitest', 'run', '--config', join(fixtureDir, 'vitest.config.ts')],
      cwd: fixtureDir,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, VITEST_HERO_COLOR: '#dc2626' },
    })

    const exitCode = await child.exited
    await new Response(child.stdout).text()
    await new Response(child.stderr).text()

    expect(exitCode).toBe(1)

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
})
