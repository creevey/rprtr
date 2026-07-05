import { describe, expect, spyOn, test } from 'bun:test'
import { join } from 'path'

import { HELP_TEXT, printHelp, resolveCliOptions, wantsHelp } from '../src/cli'

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

describe('help', () => {
  test('HELP_TEXT documents every flag and the artifact-dir positional', () => {
    expect(HELP_TEXT).toContain('Usage: crvy-rprtr')
    expect(HELP_TEXT).toContain('artifact-dir')
    for (const token of ['--port', '--screenshot-dir', '--report-path', '--output-dir', '--config', '--help']) {
      expect(HELP_TEXT).toContain(token)
    }
  })

  test('wantsHelp is true for --help and -h in any position', () => {
    expect(wantsHelp(['--help'])).toBe(true)
    expect(wantsHelp(['-h'])).toBe(true)
    expect(wantsHelp(['./artifacts', '--port', '4100', '--help'])).toBe(true)
  })

  test('wantsHelp is false without a help flag', () => {
    expect(wantsHelp([])).toBe(false)
    expect(wantsHelp(['./artifacts', '--port', '4100'])).toBe(false)
  })

  test('printHelp writes the help text to stdout', () => {
    const spy = spyOn(console, 'log')

    printHelp()

    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0]?.[0]).toBe(HELP_TEXT)
    spy.mockRestore()
  })
})
