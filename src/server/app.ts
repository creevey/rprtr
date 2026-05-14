import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

import pLimit from 'p-limit'

import { findOfflineReportPaths, mergeOfflineReportsIntoTests, parseOfflineReport } from '../offline-reports.ts'
import {
  LoadedReportDataSchema,
  TestBeginDataSchema,
  TestEndDataSchema,
  WebSocketMessageSchema,
  safeParse,
} from '../schemas.ts'
import type { OfflineReport } from '../schemas.ts'
import type { TestData, WebSocketMessage } from '../types.ts'
import { fileExists, isDirectory, readJsonFile, writeJsonFile } from './file-utils.ts'
import {
  handleTestBegin,
  handleTestEnd,
  handleRunEnd,
  handleApprove,
  handleSync,
  type HandlerContext,
} from './handlers.ts'
import { createDebouncedRefresh, watchReportArtifacts } from './report-watch.ts'
import { handleHttpRequest, type RoutesContext } from './routes.ts'
import { broadcastToBrowsers } from './utils.ts'
import type { RuntimeWebSocket } from './ws.ts'

const MAX_CONCURRENT_FILE_OPS = 5

export interface ServerOptions {
  port?: number
  screenshotDir?: string
  reportPath?: string
  /** Absolute path to the built web UI assets directory, or its parent directory */
  staticDir?: string
}

interface ReportData {
  isRunning: boolean
  tests: Record<string, TestData>
  browsers: string[]
  isUpdateMode: boolean
  screenshotDir: string
}

export interface ServerApp {
  port: number
  wsClients: Set<RuntimeWebSocket>
  close: () => void
  handleRequest: (req: Request) => Promise<Response>
  handleWebSocketMessage: (message: string) => Promise<void>
}

function createReportData(options: ServerOptions): ReportData {
  return {
    isRunning: false,
    tests: {},
    browsers: ['chromium'],
    isUpdateMode: false,
    screenshotDir: options.screenshotDir ?? './screenshots',
  }
}

function createHandlerContext(
  reportData: ReportData,
  wsClients: Set<RuntimeWebSocket>,
  currentRunIds: Set<string>,
  saveReport: () => Promise<void>,
): HandlerContext {
  return {
    reportData,
    wsClients,
    currentRunIds,
    saveReport,
  }
}

async function loadReport(reportPath: string, reportData: ReportData): Promise<void> {
  try {
    const raw = await readJsonFile(reportPath)
    if (raw === null) {
      console.log('No report.json found, using empty state')
      return
    }

    const parsed = safeParse(LoadedReportDataSchema, raw)
    if (parsed !== null) {
      reportData.tests = parsed.tests ?? {}
      reportData.isUpdateMode = parsed.isUpdateMode ?? false
    }
  } catch {
    console.log('No report.json found, using empty state')
  }
}

async function readOfflineReport(filePath: string): Promise<OfflineReport | null> {
  try {
    const raw = await readJsonFile(filePath)
    if (raw === null) {
      return null
    }

    const parsed = parseOfflineReport(raw)
    if (parsed !== null) {
      console.log(`[Server] Loading offline report: ${filePath}`)
      return parsed
    }
  } catch {
    // Skip invalid files
  }

  return null
}

async function loadOfflineReports(offlineReportDir: string, reportData: ReportData): Promise<void> {
  const offlineReportPaths = await findOfflineReportPaths(offlineReportDir)
  if (offlineReportPaths.length === 0) {
    return
  }

  const limit = pLimit(MAX_CONCURRENT_FILE_OPS)
  const reports = await Promise.all(offlineReportPaths.map((filePath) => limit(() => readOfflineReport(filePath))))
  const validReports = reports.filter((report): report is OfflineReport => report !== null)
  if (validReports.length === 0) {
    return
  }

  reportData.tests = mergeOfflineReportsIntoTests(reportData.tests, validReports, {
    screenshotDir: reportData.screenshotDir,
    screenshotsBaseUrl: '/screenshots/',
  })
}

function resetReloadableReportData(reportData: ReportData): void {
  reportData.tests = {}
  reportData.isUpdateMode = false
}

async function handleParsedWebSocketMessage(ctx: HandlerContext, msg: WebSocketMessage): Promise<void> {
  switch (msg.type) {
    case 'test-begin': {
      const parsed = safeParse(TestBeginDataSchema, msg.data)
      if (parsed === null) {
        console.error('Invalid test-begin message data', msg.data)
        break
      }

      handleTestBegin(ctx, parsed)
      break
    }
    case 'test-end': {
      const parsed = safeParse(TestEndDataSchema, msg.data)
      if (parsed === null) {
        console.error('Invalid test-end message data', msg.data)
        break
      }

      handleTestEnd(ctx, parsed)
      break
    }
    case 'run-end':
      await handleRunEnd(ctx, msg.data)
      break
    case 'approve':
      handleApprove()
      break
    case 'sync':
      handleSync(ctx)
      break
  }
}

function createWebSocketMessageHandler(getHandlerContext: () => HandlerContext): (message: string) => Promise<void> {
  return async function handleWebSocketMessage(message: string): Promise<void> {
    try {
      const parsed: unknown = JSON.parse(message)
      const wsMessage = safeParse(WebSocketMessageSchema, parsed)
      if (wsMessage === null) {
        console.error('Invalid WebSocket message: missing or invalid type', parsed)
        return
      }

      await handleParsedWebSocketMessage(getHandlerContext(), wsMessage)
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      console.error('Invalid WebSocket message:', errorMsg)
    }
  }
}

async function resolveStaticDir(staticDir?: string): Promise<string> {
  const currentDir = dirname(fileURLToPath(import.meta.url))
  const candidates =
    staticDir === undefined
      ? [
          currentDir,
          join(currentDir, 'dist'),
          join(currentDir, '..', 'dist'),
          join(currentDir, '..', '..', 'dist'),
          join(currentDir, '..'),
          join(currentDir, '..', '..'),
        ]
      : [staticDir, join(staticDir, 'dist')]

  const resolvedCandidates = await Promise.all(
    candidates.map(async (candidate) => ({
      candidate,
      exists: await fileExists(join(candidate, 'index.html')),
    })),
  )

  const resolved = resolvedCandidates.find(({ exists }) => exists)
  if (resolved !== undefined) {
    return resolved.candidate
  }

  return candidates[0]!
}

async function resolveReportPath(reportPath: string): Promise<{ reportFile: string; offlineReportDir: string }> {
  if (await isDirectory(reportPath)) {
    return { reportFile: join(reportPath, 'report.json'), offlineReportDir: reportPath }
  }
  return { reportFile: reportPath, offlineReportDir: dirname(reportPath) }
}

export async function createServerApp(options: ServerOptions = {}): Promise<ServerApp> {
  const port = options.port ?? 3000
  const reportData = createReportData(options)
  const reportPathOption = options.reportPath ?? './report.json'
  const { reportFile, offlineReportDir } = await resolveReportPath(reportPathOption)
  const staticDir = await resolveStaticDir(options.staticDir)
  const wsClients = new Set<RuntimeWebSocket>()
  const currentRunIds = new Set<string>()

  async function saveReport(): Promise<void> {
    await writeJsonFile(reportFile, reportData)
  }

  const routesContext: RoutesContext = {
    reportData,
    staticDir,
    saveReport,
  }

  const getHandlerContext = (): HandlerContext => createHandlerContext(reportData, wsClients, currentRunIds, saveReport)
  const handleRequest = (req: Request): Promise<Response> => handleHttpRequest(routesContext, req)
  const handleWebSocketMessage = createWebSocketMessageHandler(getHandlerContext)

  const reloadFromDisk = async (): Promise<void> => {
    resetReloadableReportData(reportData)
    await loadReport(reportFile, reportData)
    await loadOfflineReports(offlineReportDir, reportData)
    broadcastToBrowsers(wsClients, { type: 'sync', data: reportData })
  }

  await reloadFromDisk()
  const close = await watchReportArtifacts({
    offlineReportDir,
    screenshotDir: reportData.screenshotDir,
    scheduleRefresh: createDebouncedRefresh(reloadFromDisk),
  })

  return {
    port,
    wsClients,
    close,
    handleRequest,
    handleWebSocketMessage,
  }
}
