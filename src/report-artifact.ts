import { access, mkdir, readFile, writeFile } from 'fs/promises'
import { dirname, relative, resolve, sep } from 'path'
import { fileURLToPath } from 'url'

import { applyTestBeginEvent, applyTestEndEvent, createMutableReportState, finalizeRunEvent } from './report-state.ts'
import {
  ClientBootstrapDataSchema,
  RunEndDataSchema,
  TestBeginDataSchema,
  TestEndDataSchema,
  safeParse,
} from './schemas.ts'
import type { ClientBootstrapData, OfflineEvent } from './types.ts'

const DEFAULT_REPORT_HTML_PATH = './crvy-rprtr.html'

export const STATIC_ARTIFACT_APPROVAL_MESSAGE =
  'This artifact is read-only. Open it with the Crvy Rprtr server to approve screenshots.'

function toBrowserPath(pathValue: string): string {
  const normalized = pathValue.split(sep).join('/')

  if (normalized === '') return '.'
  if (normalized.startsWith('.')) return normalized

  return `./${normalized}`
}

function toBrowserDirPath(pathValue: string): string {
  const path = toBrowserPath(pathValue)
  return path === '.' ? './' : `${path}/`
}

function serializeBootstrapData(data: ClientBootstrapData): string {
  return JSON.stringify(data).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')
}

function escapeInlineStyle(style: string): string {
  return style.replace(/<\/style>/gi, '<\\/style>')
}

function escapeInlineScript(script: string): string {
  return script.replace(/<\/script>/gi, '<\\/script>')
}

function renderArtifactHtml(
  template: string,
  bootstrapData: ClientBootstrapData,
  stylesheet: string,
  script: string,
): string {
  const stylesheetPlaceholder = '<link rel="stylesheet" href="/dist/index.css" />'
  const scriptPlaceholder = '<script type="module" src="/dist/index.js"></script>'

  if (!template.includes(stylesheetPlaceholder) || !template.includes(scriptPlaceholder)) {
    throw new Error('Failed to find static asset placeholders in the HTML template')
  }

  const withStylesheet = template.replace(
    stylesheetPlaceholder,
    () => `<style>${escapeInlineStyle(stylesheet)}</style>`,
  )

  const bootstrapScript = `<script id="crvy-rprtr-bootstrap" type="application/json">${serializeBootstrapData(bootstrapData)}</script>`

  return withStylesheet.replace(
    scriptPlaceholder,
    () => `${bootstrapScript}\n    <script type="module">${escapeInlineScript(script)}</script>`,
  )
}

async function getPackagedAssetPath(fileName: string): Promise<string> {
  const currentDir = dirname(fileURLToPath(import.meta.url))
  const candidates = [currentDir, resolve(currentDir, '../dist')]
  const resolvedCandidates = await Promise.all(
    candidates.map(async (candidate) => {
      const assetPath = resolve(candidate, fileName)
      try {
        await access(assetPath)
        return assetPath
      } catch {
        return null
      }
    }),
  )

  const resolvedAssetPath = resolvedCandidates.find((assetPath): assetPath is string => assetPath !== null)
  if (resolvedAssetPath !== undefined) {
    return resolvedAssetPath
  }

  throw new Error(
    `Could not find packaged asset "${fileName}". Run "bun run build" before generating report artifacts.`,
  )
}

function replayEvents(
  state: ReturnType<typeof createMutableReportState>,
  events: Array<{ type: OfflineEvent['type']; data: unknown }>,
  screenshotsBaseUrl: string,
): void {
  for (const event of events) {
    switch (event.type) {
      case 'test-begin': {
        const parsed = safeParse(TestBeginDataSchema, event.data)
        if (parsed !== null) {
          applyTestBeginEvent(state, parsed)
        }
        break
      }
      case 'test-end': {
        const parsed = safeParse(TestEndDataSchema, event.data)
        if (parsed !== null) {
          applyTestEndEvent(state, parsed, { screenshotsBaseUrl })
        }
        break
      }
      case 'run-end': {
        const parsed = safeParse(RunEndDataSchema, event.data)
        if (parsed?.environments !== undefined) {
          Object.assign(state.reportData.environments, parsed.environments)
        }
        finalizeRunEvent(state)
        break
      }
    }
  }
}

function buildStaticBootstrapData(
  events: Array<{ type: OfflineEvent['type']; data: unknown }>,
  screenshotDir: string,
  htmlPath: string,
): ClientBootstrapData {
  const screenshotBaseUrl = toBrowserDirPath(relative(dirname(htmlPath), resolve(screenshotDir)))
  const state = createMutableReportState(screenshotDir)
  replayEvents(state, events, screenshotBaseUrl)

  const bootstrapData: ClientBootstrapData = {
    report: {
      tests: state.reportData.tests,
      isUpdateMode: state.reportData.isUpdateMode,
      ...(Object.keys(state.reportData.environments).length === 0
        ? {}
        : { environments: state.reportData.environments }),
    },
    liveUpdates: false,
    approvalEnabled: false,
    approvalMessage: STATIC_ARTIFACT_APPROVAL_MESSAGE,
  }

  const parsedBootstrapData = safeParse(ClientBootstrapDataSchema, bootstrapData)
  if (parsedBootstrapData === null) {
    throw new Error('Failed to build static report bootstrap data')
  }

  return parsedBootstrapData
}

export interface WriteReportArtifactOptions {
  events: Array<{ type: OfflineEvent['type']; data: unknown }>
  screenshotDir: string
  reportHtmlPath?: string
}

export async function writeReportArtifact(options: WriteReportArtifactOptions): Promise<void> {
  const reportHtmlPath = resolve(options.reportHtmlPath ?? DEFAULT_REPORT_HTML_PATH)
  const [indexHtmlPath, indexJsPath, indexCssPath] = await Promise.all([
    getPackagedAssetPath('index.html'),
    getPackagedAssetPath('index.js'),
    getPackagedAssetPath('index.css'),
  ])

  await mkdir(dirname(reportHtmlPath), { recursive: true })
  const [template, script, stylesheet] = await Promise.all([
    readFile(indexHtmlPath, 'utf8'),
    readFile(indexJsPath, 'utf8'),
    readFile(indexCssPath, 'utf8'),
  ])
  const bootstrapData = buildStaticBootstrapData(options.events, options.screenshotDir, reportHtmlPath)
  const html = renderArtifactHtml(template, bootstrapData, stylesheet, script)

  await writeFile(reportHtmlPath, html)
}
