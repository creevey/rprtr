import type { RunEnvironments } from './browser-pins.ts'
import { isCI } from './ci.ts'
import { log, logError } from './debug-log.ts'
import { type RunEvent, writeOfflineReport, writeStaticArtifact } from './reporter-artifact-ops.ts'

export interface ReporterTransportOptions {
  serverUrl?: string
  screenshotDir?: string
  offlineReportPath?: string
  reportHtmlPath?: string
  workerIndex?: number
  ci?: boolean
}

export class ReporterTransport {
  private ws: WebSocket | null = null
  readonly serverUrl: string
  readonly screenshotDir: string
  private queue: string[] = []
  private workerIndex: number
  private offlineReportPath: string
  private reportHtmlPath: string
  private isOfflineMode = false
  private runEvents: RunEvent[] = []
  readonly ci: boolean

  constructor(options: ReporterTransportOptions = {}) {
    this.serverUrl = options.serverUrl ?? process.env.CRVY_RPRTR_SERVER_URL ?? 'ws://localhost:3000'
    this.screenshotDir = options.screenshotDir ?? './screenshots'
    this.workerIndex = options.workerIndex ?? (parseInt(process.env.TEST_WORKER_INDEX ?? '0', 10) || 0)
    this.offlineReportPath = options.offlineReportPath ?? `./crvy-rprtr-${this.workerIndex}.json`
    this.reportHtmlPath = options.reportHtmlPath ?? './crvy-rprtr.html'
    this.ci = options.ci ?? isCI()
    if (this.ci) this.isOfflineMode = true
  }

  start(): void {
    if (!this.ci) this.connect()
  }

  connect(): void {
    const WebSocketConstructor = globalThis.WebSocket
    if (typeof WebSocketConstructor !== 'function') {
      log('[CrvyRprtr] WebSocket unavailable in current runtime; offline mode enabled')
      this.enableOfflineMode()
      return
    }
    try {
      this.ws = new WebSocketConstructor(this.serverUrl)
      this.ws.onopen = (): void => {
        log('[CrvyRprtr] Connected to Crvy Rprtr server')
        this.isOfflineMode = false
        for (const message of this.queue) this.ws!.send(message)
        this.queue = []
      }
      this.ws.onerror = (error): void => {
        logError('[CrvyRprtr] WebSocket error:', error)
        this.enableOfflineMode()
      }
      this.ws.onclose = (): void => {
        log('[CrvyRprtr] Disconnected from Crvy Rprtr server')
        this.enableOfflineMode()
      }
    } catch (error) {
      logError('[CrvyRprtr] Failed to connect:', error)
      this.enableOfflineMode()
    }
  }

  private enableOfflineMode(): void {
    if (this.isOfflineMode) return
    this.isOfflineMode = true
    log('[CrvyRprtr] Offline mode enabled - events will be queued to file')
  }

  send(message: object): void {
    const event = message as { type?: string; data?: unknown }
    if (event.type === 'test-begin' || event.type === 'test-end' || event.type === 'run-end')
      this.runEvents.push({ type: event.type, data: event.data })
    const payload = JSON.stringify(message)
    if (!this.isOfflineMode) {
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(payload)
      else this.queue.push(payload)
    }
  }

  async finish(
    runEndData: { status: string; environments?: RunEnvironments },
    flushPendingArtifacts?: () => Promise<void>,
  ): Promise<void> {
    this.send({ type: 'run-end', data: runEndData })
    if (this.ci) {
      await flushPendingArtifacts?.()
      await writeStaticArtifact(this.runEvents, this.screenshotDir, this.reportHtmlPath)
      await writeOfflineReport(this.runEvents, this.offlineReportPath, this.workerIndex)
    }

    await new Promise<void>((resolve) => {
      if (!this.ws || this.ws.readyState === WebSocket.CLOSED) {
        resolve()
        return
      }
      this.ws.onclose = (): void => {
        resolve()
      }
      setTimeout(() => {
        this.ws?.close()
        resolve()
      }, 1000)
      this.ws.close()
    })
  }
}
