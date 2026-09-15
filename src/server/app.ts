import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

import { loadOfflineReports } from '../offline-reports.ts'
import type { FontRendering } from '../rendering.ts'
import {
  IncomingWebSocketMessageSchema,
  RegisterDataSchema,
  RunEndDataSchema,
  TestBeginDataSchema,
  TestEndDataSchema,
  safeParse,
  type IncomingWebSocketMessage,
} from '../schemas.ts'
import { type DockerOptions } from './docker-launcher.ts'
import { fileExists } from './file-utils.ts'
import {
  handleTestBegin,
  handleTestEnd,
  handleRunEnd,
  handleApprove,
  handleSync,
  handleRegister,
  type HandlerContext,
} from './handlers.ts'
import { resolveRunBackend } from './launcher-resolver.ts'
import { createReportData, loadReport, resolveReportPath, type ReportData } from './report-bootstrap.ts'
import { createReportPersistence } from './report-persistence.ts'
import { createRoutesContext } from './routes-context.ts'
import { handleHttpRequest, type RoutesContext } from './routes.ts'
import { type RunLauncher } from './run-launcher.ts'
import { type RunMode } from './run-mode.ts'
import { createCloseHandler, createRunControllerAndHandlers } from './server-factories.ts'
import { broadcastToBrowsers } from './utils.ts'
import { resolveSeedRunContext, seedDiscoveredTests, withoutDiscoveredTests } from './vitest-seeding.ts'
import type { RuntimeWebSocket } from './ws.ts'

export interface ServerOptions {
  port?: number
  screenshotDir?: string
  reportPath?: string
  /** Absolute path to the built web UI assets directory, or its parent directory */
  staticDir?: string
  /**
   * Playwright config path used to seed run support before any reporter
   * registers. When omitted, the server discovers `playwright.config.*` in the
   * working directory. A registering reporter always overrides this.
   */
  playwrightConfig?: string
  configDir?: string
  /**
   * Playwright's outputDir (test-results), where failure artifacts are written. Used as a root in
   * the `/file` serving allowlist. Relative paths are resolved against the server's working
   * directory, so start the server from the same directory the tests ran in.
   */
  outputDir?: string
  playwrightTestDir?: string
  playwrightSnapshotDir?: string
  playwrightSnapshotPathTemplate?: string
  playwrightToHaveScreenshotPathTemplate?: string
  /** Execution backend for UI-triggered runs. Default 'auto'. */
  runMode?: RunMode
  /** Docker backend settings; only used when the resolved mode is 'docker'. */
  docker?: DockerOptions
  /**
   * Text antialiasing for UI-triggered runs in either mode. `'grayscale'` (default) pins
   * grayscale AA — a fontconfig drop-in in docker mode, a `FONTCONFIG_FILE` override in local
   * mode — so screenshots do not depend on the machine's subpixel settings. `'inherit'`
   * restores Playwright's default, i.e. whatever the environment renders, when faithful
   * desktop text matters more than determinism.
   */
  fontRendering?: FontRendering
}

export interface ServerApp {
  port: number
  wsClients: Set<RuntimeWebSocket>
  /** Flushes pending report writes and disposes the run controller. */
  close: () => Promise<void>
  handleRequest: (req: Request) => Promise<Response>
  handleWebSocketMessage: (message: string) => Promise<void>
}

async function handleParsedWebSocketMessage(ctx: HandlerContext, msg: IncomingWebSocketMessage): Promise<void> {
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
    case 'run-end': {
      const parsed = safeParse(RunEndDataSchema, msg.data)
      if (parsed === null) {
        console.error('Invalid run-end message data', msg.data)
        break
      }
      await handleRunEnd(ctx, parsed)
      break
    }
    case 'approve':
      handleApprove()
      break
    case 'sync':
      handleSync(ctx)
      break
    case 'register': {
      const parsed = safeParse(RegisterDataSchema, msg.data)
      if (parsed === null) {
        console.error('Invalid register message data', msg.data)
        break
      }
      handleRegister(ctx, parsed)
      break
    }
  }
}

function createWebSocketMessageHandler(getHandlerContext: () => HandlerContext): (message: string) => Promise<void> {
  return async function handleWebSocketMessage(message: string): Promise<void> {
    try {
      const parsed: unknown = JSON.parse(message)
      const wsMessage = safeParse(IncomingWebSocketMessageSchema, parsed)
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

async function seedRunContext(routesContext: RoutesContext, options: ServerOptions): Promise<void> {
  if (routesContext.runContext !== undefined) {
    return
  }
  const runContext = await resolveSeedRunContext(options.playwrightConfig, process.cwd())
  if (runContext !== null) {
    routesContext.runContext = runContext
  }
}

/** Resolves the launcher + routes context (and seeds runContext) so the UI can trigger runs early. */
async function setupRoutesContext(
  options: ServerOptions,
  reportData: ReportData,
  staticDir: string,
  saveReport: () => Promise<void>,
  port: number,
): Promise<{
  routesContext: RoutesContext
  launcher: RunLauncher
  localLauncher: RunLauncher
  configuredRunMode: RunMode
}> {
  const { launcher, localLauncher, configuredRunMode, routesContextOptions } = await resolveRunBackend({
    runMode: options.runMode,
    docker: options.docker,
    fontRendering: options.fontRendering,
    port,
  })
  const routesContext = createRoutesContext(reportData, staticDir, saveReport, {
    ...options,
    ...routesContextOptions,
  })
  await seedRunContext(routesContext, options)
  return { routesContext, launcher, localLauncher, configuredRunMode }
}

/** Fire-and-forget startup listing for a discovered Vitest project: the sidebar
 * pre-populates when it lands; the run controls stay enabled even if it fails. */
function startVitestDiscovery(
  runContext: RoutesContext['runContext'],
  reportData: ReportData,
  wsClients: Set<RuntimeWebSocket>,
): void {
  void seedDiscoveredTests({
    runContext,
    reportData,
    broadcast: (message): void => {
      broadcastToBrowsers(wsClients, message)
    },
  }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    console.error('[VitestDiscovery] test listing failed:', message)
  })
}

export async function createServerApp(options: ServerOptions = {}): Promise<ServerApp> {
  const port = options.port ?? 3000
  const reportData = createReportData(options.screenshotDir)
  const reportPathOption = options.reportPath ?? './report.json'
  const { reportFile, offlineReportDir } = await resolveReportPath(reportPathOption)
  const staticDir = await resolveStaticDir(options.staticDir)
  const wsClients = new Set<RuntimeWebSocket>()
  const currentRunIds = new Set<string>()
  const persistence = createReportPersistence(reportFile, () => withoutDiscoveredTests(reportData))
  const { routesContext, launcher, localLauncher, configuredRunMode } = await setupRoutesContext(
    options,
    reportData,
    staticDir,
    persistence.saveReport,
    port,
  )
  const { runController, getHandlerContext } = createRunControllerAndHandlers(
    routesContext,
    wsClients,
    reportData,
    currentRunIds,
    port,
    persistence,
    launcher,
    localLauncher,
    configuredRunMode,
  )
  const handleRequest = (req: Request): Promise<Response> => handleHttpRequest(routesContext, req, runController)
  const handleWebSocketMessage = createWebSocketMessageHandler(getHandlerContext)

  await loadReport(reportFile, reportData)
  await loadOfflineReports(reportData, offlineReportDir)

  startVitestDiscovery(routesContext.runContext, reportData, wsClients)

  return {
    port,
    wsClients,
    close: createCloseHandler(persistence, runController),
    handleRequest,
    handleWebSocketMessage,
  }
}
