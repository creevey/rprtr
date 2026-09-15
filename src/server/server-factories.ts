import type { TestData } from '../types.ts'
import type { HandlerContext } from './handlers.ts'
import type { ReportPersistence } from './report-persistence.ts'
import type { RoutesContext } from './routes.ts'
import { RunController, createRealSpawn, createRealTimers, type RunContext } from './run-controller.ts'
import type { RunLauncher } from './run-launcher.ts'
import type { RunMode } from './run-mode.ts'
import { broadcastToBrowsers } from './utils.ts'
import { dropDiscoveredTests } from './vitest-seeding.ts'
import type { RuntimeWebSocket } from './ws.ts'

interface ServerFactoryReportData {
  isRunning: boolean
  tests: Record<string, TestData>
  browsers: string[]
  isUpdateMode: boolean
  screenshotDir: string
}

function createServerRunController(
  routesContext: RoutesContext,
  wsClients: Set<RuntimeWebSocket>,
  reportData: ServerFactoryReportData,
  port: number,
  setRunFiltered: (filtered: boolean) => void,
  saveReport: () => Promise<void>,
  launcher: RunLauncher,
  localLauncher: RunLauncher,
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
    onRunStart: (): void => {
      dropDiscoveredTests(reportData, (message): void => {
        broadcastToBrowsers(wsClients, message)
      })
    },
    setRunFiltered,
    containerPathMapping: routesContext.containerPathMapping,
    saveReport,
    spawn: createRealSpawn(),
    timers: createRealTimers(),
    launcher,
    localLauncher,
    getRunMode: (): RunMode => configuredRunMode,
  })
}

export function createCloseHandler(persistence: ReportPersistence, runController: RunController): () => Promise<void> {
  return async (): Promise<void> => {
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
