import { describe, expect, test } from 'bun:test'
import { join } from 'path'

import { resolveCliOptions } from '../src/cli'

describe('resolveCliOptions', () => {
  test('keeps the current defaults without an artifact directory', () => {
    expect(resolveCliOptions([])).toEqual({
      port: 3000,
      screenshotDir: './screenshots',
      reportPath: './report.json',
      outputDir: './test-results',
    })
  })

  test('derives report and screenshot paths from a positional artifact directory', () => {
    const artifactDir = './artifacts'

    expect(resolveCliOptions([artifactDir])).toEqual({
      port: 3000,
      screenshotDir: join(artifactDir, 'screenshots'),
      reportPath: join(artifactDir, 'report.json'),
      outputDir: './test-results',
    })
  })

  test('lets explicit report path override positional artifact directory', () => {
    const artifactDir = './artifacts'
    const reportPath = './custom/report.json'

    expect(resolveCliOptions([artifactDir, '--report-path', reportPath])).toEqual({
      port: 3000,
      screenshotDir: join(artifactDir, 'screenshots'),
      reportPath,
      outputDir: './test-results',
    })
  })

  test('lets explicit flags override positional defaults', () => {
    expect(
      resolveCliOptions([
        './artifacts',
        '--port',
        '4100',
        '--report-path',
        './custom/report.json',
        '--screenshot-dir',
        './custom/screenshots',
      ]),
    ).toEqual({
      port: 4100,
      screenshotDir: './custom/screenshots',
      reportPath: './custom/report.json',
      outputDir: './test-results',
    })
  })

  test('rejects more than one positional artifact directory', () => {
    expect(() => resolveCliOptions(['./artifacts', './other'])).toThrow('Expected at most one artifact directory')
  })

  test('--output-dir sets outputDir', () => {
    expect(resolveCliOptions(['--output-dir', '/custom/results']).outputDir).toBe('/custom/results')
  })

  test('-o short flag sets outputDir', () => {
    expect(resolveCliOptions(['-o', '/x']).outputDir).toBe('/x')
  })

  test('outputDir defaults to ./test-results when omitted', () => {
    expect(resolveCliOptions([]).outputDir).toBe('./test-results')
  })

  test('--config sets playwrightConfig', () => {
    expect(resolveCliOptions(['--config', './pw.config.ts']).playwrightConfig).toBe('./pw.config.ts')
  })

  test('-c short flag sets playwrightConfig', () => {
    expect(resolveCliOptions(['-c', './pw.config.ts']).playwrightConfig).toBe('./pw.config.ts')
  })

  test('playwrightConfig is undefined when omitted', () => {
    expect(resolveCliOptions([]).playwrightConfig).toBeUndefined()
  })
})
