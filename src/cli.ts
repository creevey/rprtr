#!/usr/bin/env node
import { join } from 'path'
import { parseArgs } from 'util'

import { isDirectExecution } from './is-direct-execution.ts'
import type { FontRendering } from './rendering.ts'
import { startServer, type ServerOptions } from './server.ts'
import type { DockerOptions } from './server/docker-launcher.ts'
import type { RunMode } from './server/run-mode.ts'

const DEFAULT_PORT = 3000
const DEFAULT_SCREENSHOT_DIR = './screenshots'
const DEFAULT_REPORT_PATH = './report.json'
const DEFAULT_OUTPUT_DIR = './test-results'

interface ResolvedCliOptions extends ServerOptions {
  port: number
  screenshotDir: string
  reportPath: string
  outputDir: string
  runMode?: RunMode
  docker?: DockerOptions
  fontRendering?: FontRendering
}

export const HELP_TEXT = `Usage: crvy-rprtr [artifact-dir] [options]

Start the @crvy/rprtr visual regression report UI server.

Arguments:
  artifact-dir                Directory of downloaded CI test artifacts. When set,
                              --report-path defaults to <dir>/report.json and
                              --screenshot-dir defaults to <dir>/screenshots.

Options:
  -p, --port <number>           Server port (default: 3000)
  -s, --screenshot-dir <dir>    Screenshot artifact directory (default: ./screenshots)
  -r, --report-path <path>      Path to report.json (default: ./report.json)
  -o, --output-dir <dir>        Playwright test output directory (default: ./test-results)
  -c, --config <path>           Path to playwright.config.ts, used for approval routing
  --run-mode <mode>             Test run backend: local, docker, or auto (default: auto)
  --docker-image <image>        Docker image for docker mode (default: official Playwright image matching the installed @playwright/test version)
  --docker-platform <platform>  Container platform: linux/amd64 or linux/arm64 (default: host architecture)
  --font-rendering <mode>       Text antialiasing for runs: grayscale (default, deterministic) or inherit (the environment's own rendering)
  -h, --help                    Show this help message
`

export function printHelp(): void {
  console.log(HELP_TEXT)
}

export function wantsHelp(args: string[]): boolean {
  return args.includes('--help') || args.includes('-h')
}

function parseRunMode(value: string | undefined): RunMode | undefined {
  if (value === undefined) return undefined
  if (value !== 'local' && value !== 'docker' && value !== 'auto') {
    throw new TypeError(`Invalid --run-mode: ${value} (expected local, docker, or auto)`)
  }
  return value
}

function parseDockerPlatform(value: string | undefined): DockerOptions['platform'] {
  if (value === undefined) return undefined
  if (value !== 'linux/amd64' && value !== 'linux/arm64') {
    throw new TypeError(`Invalid --docker-platform: ${value} (expected linux/amd64 or linux/arm64)`)
  }
  return value
}

function parseFontRendering(value: string | undefined): FontRendering | undefined {
  if (value === undefined) return undefined
  if (value !== 'grayscale' && value !== 'inherit') {
    throw new TypeError(`Invalid --font-rendering: ${value} (expected grayscale or inherit)`)
  }
  return value
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
      'run-mode': { type: 'string' },
      'docker-image': { type: 'string' },
      'docker-platform': { type: 'string' },
      'font-rendering': { type: 'string' },
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

  const runMode = parseRunMode(values['run-mode'])
  const dockerPlatform = parseDockerPlatform(values['docker-platform'])
  const fontRendering = parseFontRendering(values['font-rendering'])
  const docker: DockerOptions = {}
  if (values['docker-image'] !== undefined) docker.image = values['docker-image']
  if (dockerPlatform !== undefined) docker.platform = dockerPlatform
  const hasDockerOptions = values['docker-image'] !== undefined || dockerPlatform !== undefined

  return {
    port: parseInt(values.port ?? `${DEFAULT_PORT}`, 10),
    screenshotDir,
    reportPath,
    outputDir: values['output-dir'] ?? DEFAULT_OUTPUT_DIR,
    playwrightConfig: values.config,
    ...(runMode === undefined ? {} : { runMode }),
    ...(fontRendering === undefined ? {} : { fontRendering }),
    ...(hasDockerOptions ? { docker } : {}),
  }
}

if (isDirectExecution(import.meta.url)) {
  const args = process.argv.slice(2)

  if (wantsHelp(args)) {
    printHelp()
  } else {
    await startServer(resolveCliOptions(args))
  }
}
