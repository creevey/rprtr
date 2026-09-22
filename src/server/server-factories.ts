import type { BrowserSidecar } from './browser-sidecar.ts'
import type { DiscoverySession } from './discovered-tests.ts'
import type { HandlerContext } from './handlers.ts'
import type { ReportPersistence } from './report-persistence.ts'
import type { RoutesContext } from './routes.ts'
import { RunController, createRealSpawn, createRealTimers, type RunContext } from './run-controller.ts'
import type { RunLauncher } from './run-launcher.ts'
import type { RunMode } from './run-mode.ts'
import { broadcastToBrowsers } from './utils.ts'
import type { RuntimeWebSocket } from './ws.ts'

type ServerFactoryReportData = RoutesContext['reportData']

function createServerRunController(
  routesContext: RoutesContext,
  wsClients: Set<RuntimeWebSocket>,
  reportData: ServerFactoryReportData,
  port: number,
  setRunFiltered: (filtered: boolean) => void,
  saveReport: () => Promise<void>,
  launcher: RunLauncher,
  localLauncher: RunLauncher,
  browserSidecar: BrowserSidecar,
  configuredRunMode: RunMode,
): RunController {
  return new RunController({
    getRunContext: (): RunContext | null => routesContext.runContext ?? null,
    port,
    broadcast: (message): void => {
      broadcastToBrowsers(wsClients, message)
    },
    setReportRunning: (running): void => {
      reportData.isRunning = running
    },
    setRunFiltered,
    notifyRunSettled: (): void => {
      routesContext.notifyRunSettled?.()
    },
    containerPathMapping: routesContext.containerPathMapping,
    saveReport,
    spawn: createRealSpawn(),
    timers: createRealTimers(),
    launcher,
    localLauncher,
    browserSidecar,
    getRunMode: (): RunMode => configuredRunMode,
  })
}

export function createCloseHandler(
  persistence: ReportPersistence,
  runController: RunController,
  discovery?: DiscoverySession | null,
): () => Promise<void> {
  return async (): Promise<void> => {
    discovery?.dispose()
    await persistence.dispose()
    runController.dispose()
  }
}

export function createRunControllerAndHandlers(
  routesContext: RoutesContext,
  wsClients: Set<RuntimeWebSocket>,
  reportData: ServerFactoryReportData,
  currentRunIds: Set<string>,
  port: number,
  persistence: ReportPersistence,
  launcher: RunLauncher,
  localLauncher: RunLauncher,
  browserSidecar: BrowserSidecar,
  configuredRunMode: RunMode,
): { runController: RunController; getHandlerContext: () => HandlerContext } {
  let isFilteredRun = false
  const runController = createServerRunController(
    routesContext,
    wsClients,
    reportData,
    port,
    (filtered) => {
      isFilteredRun = filtered
    },
    persistence.saveReport,
    launcher,
    localLauncher,
    browserSidecar,
    configuredRunMode,
  )
  const getHandlerContext = (): HandlerContext => ({
    reportData,
    wsClients,
    currentRunIds,
    isFilteredRun,
    saveReport: persistence.saveReport,
    scheduleReportSave: persistence.scheduleReportSave,
    approvalRouting: routesContext.approvalRouting,
    routesContext,
    runController,
  })
  return { runController, getHandlerContext }
}
