#!/usr/bin/env node
import { join } from 'path'
import { parseArgs } from 'util'

import { isDirectExecution } from './is-direct-execution.ts'
import { startServer, type ServerOptions } from './server.ts'

const DEFAULT_PORT = 3000
const DEFAULT_SCREENSHOT_DIR = './screenshots'
const DEFAULT_REPORT_PATH = './report.json'
const DEFAULT_OUTPUT_DIR = './test-results'

interface ResolvedCliOptions extends ServerOptions {
  port: number
  screenshotDir: string
  reportPath: string
  outputDir: string
}

export function resolveCliOptions(args: string[]): ResolvedCliOptions {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      port: { type: 'string', short: 'p', default: `${DEFAULT_PORT}` },
      'screenshot-dir': { type: 'string', short: 's' },
      'report-path': { type: 'string', short: 'r' },
      'output-dir': { type: 'string', short: 'o' },
      config: { type: 'string', short: 'c' },
    },
  })

  if (positionals.length > 1) {
    throw new TypeError(`Expected at most one artifact directory, received ${positionals.length}`)
  }

  const artifactDir = positionals[0]
  const reportPath =
    values['report-path'] ?? (artifactDir === undefined ? DEFAULT_REPORT_PATH : join(artifactDir, 'report.json'))
  const screenshotDir =
    values['screenshot-dir'] ?? (artifactDir === undefined ? DEFAULT_SCREENSHOT_DIR : join(artifactDir, 'screenshots'))

  return {
    port: parseInt(values.port ?? `${DEFAULT_PORT}`, 10),
    screenshotDir,
    reportPath,
    outputDir: values['output-dir'] ?? DEFAULT_OUTPUT_DIR,
    playwrightConfig: values.config,
  }
}

if (isDirectExecution(import.meta.url)) {
  await startServer(resolveCliOptions(process.argv.slice(2)))
}
