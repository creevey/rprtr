import { existsSync } from 'fs'
import { copyFile, mkdir, writeFile } from 'fs/promises'
import { dirname, join } from 'path'

import type { FullConfig, FullResult, Reporter, Suite, TestCase, TestResult } from '@playwright/test/reporter'
import pLimit from 'p-limit'

import { writeReportArtifact } from './report-artifact.ts'
import { type AttachmentData, type ScreenshotDeclaration, extractScreenshotDeclarations } from './reporter-utils.ts'
import { resolveBaselineTargets } from './snapshot-path-resolver.ts'
const MAX_CONCURRENT_FILE_OPS = 5,
  SAFE_ARTIFACT_CHARACTER = /^[A-Za-z0-9._-]$/

type RunEvent = { type: 'test-begin' | 'test-end' | 'run-end'; data: unknown }
type BaselineResolverInput = Parameters<typeof resolveBaselineTargets>[0]
type ResolvedBaselineTarget = ReturnType<typeof resolveBaselineTargets>[number]
const encodeArtifactPathSegment = (segment: string): string =>
  segment === '.' || segment === '..'
    ? segment.replace(/\./g, '%2E')
    : Array.from(segment, (character) =>
        SAFE_ARTIFACT_CHARACTER.test(character) ? character : encodeURIComponent(character),
      ).join('')
const copiedBaselineArtifactPath = (attachmentName: string): string =>
  attachmentName.split('/').map(encodeArtifactPathSegment).join('/')
export interface CrvyRprtrOptions {
  serverUrl?: string
  screenshotDir?: string
  offlineReportPath?: string
  reportHtmlPath?: string
  playwrightSnapshotDir?: string
  playwrightSnapshotPathTemplate?: string
  playwrightToHaveScreenshotPathTemplate?: string
}
export class CrvyRprtr implements Reporter {
  private ws: WebSocket | null = null
  private serverUrl: string
  private screenshotDir: string
  private queue: string[] = []
  private workerIndex: number
  private offlineReportPath: string
  private reportHtmlPath: string
  private configDir = process.cwd()
  private testMetadata = new Map<string, { reporterTitlePath: string[] }>()
  private playwrightSnapshotDir?: string
  private playwrightSnapshotPathTemplate?: string
  private playwrightToHaveScreenshotPathTemplate?: string
  private isOfflineMode = false
  private hadOfflineMode = false
  private runEvents: RunEvent[] = []
  constructor(options: CrvyRprtrOptions = {}) {
    this.serverUrl = options.serverUrl ?? 'ws://localhost:3000'
    this.screenshotDir = options.screenshotDir ?? './screenshots'
    this.workerIndex = parseInt(process.env.TEST_WORKER_INDEX ?? '0', 10) || 0
    this.offlineReportPath = options.offlineReportPath ?? `./crvy-rprtr-${this.workerIndex}.json`
    this.reportHtmlPath = options.reportHtmlPath ?? './crvy-rprtr.html'
    this.playwrightSnapshotDir = options.playwrightSnapshotDir
    this.playwrightSnapshotPathTemplate = options.playwrightSnapshotPathTemplate
    this.playwrightToHaveScreenshotPathTemplate = options.playwrightToHaveScreenshotPathTemplate
  }
  async onBegin(config: FullConfig, suite: Suite): Promise<void> {
    this.configDir = config.configFile === undefined ? config.rootDir : dirname(config.configFile)
    console.log(`[CrvyRprtr] Starting run with ${suite.allTests().length} tests`)
    await mkdir(this.screenshotDir, { recursive: true })
    this.connect()
  }
  private connect(): void {
    const WebSocketConstructor = globalThis.WebSocket
    if (typeof WebSocketConstructor !== 'function') {
      console.log('[CrvyRprtr] WebSocket unavailable in current runtime; offline mode enabled')
      this.enableOfflineMode()
      return
    }
    try {
      this.ws = new WebSocketConstructor(this.serverUrl)
      this.ws.onopen = (): void => {
        console.log('[CrvyRprtr] Connected to Crvy Rprtr server')
        this.isOfflineMode = false
        for (const message of this.queue) this.ws!.send(message)
        this.queue = []
      }
      this.ws.onerror = (error): void => {
        console.error('[CrvyRprtr] WebSocket error:', error)
        this.enableOfflineMode()
      }
      this.ws.onclose = (): void => {
        console.log('[CrvyRprtr] Disconnected from Crvy Rprtr server')
        this.enableOfflineMode()
      }
    } catch (error) {
      console.error('[CrvyRprtr] Failed to connect:', error)
      this.enableOfflineMode()
    }
  }
  private enableOfflineMode(): void {
    if (this.isOfflineMode) return
    this.isOfflineMode = this.hadOfflineMode = true
    console.log('[CrvyRprtr] Offline mode enabled - events will be queued to file')
  }
  private describeTitlePath(test: TestCase): string[] {
    const titlePath: string[] = []
    for (let suite: Suite | undefined = test.parent; suite?.type === 'describe'; suite = suite.parent)
      titlePath.unshift(suite.title)
    return titlePath
  }
  private reporterTitlePath(test: TestCase): string[] {
    return typeof test.titlePath === 'function'
      ? test.titlePath()
      : ['', test.parent.project()?.name ?? 'chromium', test.location.file, ...this.describeTitlePath(test), test.title]
  }
  onTestBegin(test: TestCase): void {
    this.testMetadata.set(test.id, { reporterTitlePath: this.reporterTitlePath(test) })
    this.send({
      type: 'test-begin',
      data: {
        id: test.id,
        title: test.title,
        titlePath: this.describeTitlePath(test),
        browser: test.parent.project()?.name ?? 'chromium',
        location: { file: test.location.file, line: test.location.line },
      },
    })
  }
  async onTestEnd(test: TestCase, result: TestResult): Promise<void> {
    const screenshotDeclarations = extractScreenshotDeclarations(result.steps)
    const savedAttachments = await this.saveAttachments(test.id, result)
    try {
      await this.copySnapshotBaselines(test, result.status, screenshotDeclarations, savedAttachments)
      this.send({
        type: 'test-end',
        data: {
          id: test.id,
          title: test.title,
          status: result.status,
          attachments: savedAttachments,
          visualNames: screenshotDeclarations.map(({ visualName }) => visualName),
          error: result.errors.length > 0 ? result.errors[0]?.message : undefined,
          duration: result.duration,
        },
      })
    } finally {
      this.testMetadata.delete(test.id)
    }
  }
  private baselineResolverInput(
    test: TestCase,
    declarations: readonly ScreenshotDeclaration[],
  ): BaselineResolverInput | null {
    const project = test.parent.project()
    const snapshotDir = this.playwrightSnapshotDir ?? project?.snapshotDir
    if (project === undefined || typeof project.testDir !== 'string' || typeof snapshotDir !== 'string') return null
    return {
      testFile: test.location.file,
      reporterTitlePath: this.testMetadata.get(test.id)?.reporterTitlePath ?? this.reporterTitlePath(test),
      declarations,
      config: {
        configDir: this.configDir,
        testDir: project.testDir,
        snapshotDir,
        projectName: project.name,
        snapshotSuffix: process.platform,
        snapshotPathTemplate: this.playwrightSnapshotPathTemplate,
        toHaveScreenshotPathTemplate: this.playwrightToHaveScreenshotPathTemplate,
      },
      snapshotPathExists: existsSync,
    }
  }
  private async copyResolvedBaseline(
    safeTestId: string,
    testScreenshotDir: string,
    target: ResolvedBaselineTarget,
    savedAttachments: AttachmentData[],
  ): Promise<void> {
    const attachmentName = `${target.attachmentBaseName}-expected.png`
    const artifactPath = copiedBaselineArtifactPath(attachmentName)
    const destPath = join(testScreenshotDir, artifactPath)
    try {
      await mkdir(dirname(destPath), { recursive: true })
      await copyFile(target.snapshotPath, destPath)
      savedAttachments.push({ name: attachmentName, path: `${safeTestId}/${artifactPath}`, contentType: 'image/png' })
      console.log(`[CrvyRprtr] Attached baseline: ${target.snapshotPath}`)
    } catch {
      // keep declared-only when no exact baseline exists
    }
  }
  private async copySnapshotBaselines(
    test: TestCase,
    status: TestResult['status'],
    screenshotDeclarations: readonly ScreenshotDeclaration[],
    savedAttachments: AttachmentData[],
  ): Promise<void> {
    if (status !== 'passed' || screenshotDeclarations.length === 0) return
    const input = this.baselineResolverInput(test, screenshotDeclarations)
    if (input === null) return
    const targets = resolveBaselineTargets(input)
    if (targets.length === 0) return
    const safeTestId = this.sanitizeId(test.id)
    const testScreenshotDir = join(this.screenshotDir, safeTestId)
    const limit = pLimit(MAX_CONCURRENT_FILE_OPS)
    await Promise.all(
      targets.map((target) =>
        limit(() => this.copyResolvedBaseline(safeTestId, testScreenshotDir, target, savedAttachments)),
      ),
    )
  }
  private async saveAttachments(testId: string, result: TestResult): Promise<AttachmentData[]> {
    const savedAttachments: AttachmentData[] = []
    const safeTestId = this.sanitizeId(testId)
    const testScreenshotDir = join(this.screenshotDir, safeTestId)
    const limit = pLimit(MAX_CONCURRENT_FILE_OPS)
    await Promise.all(
      result.attachments
        .filter(
          (attachment): attachment is typeof attachment & { path: string } =>
            attachment.contentType === 'image/png' && attachment.path !== undefined,
        )
        .map((attachment) =>
          limit(async () => {
            try {
              await mkdir(testScreenshotDir, { recursive: true })
              const destPath = join(testScreenshotDir, attachment.name)
              await copyFile(attachment.path, destPath)
              savedAttachments.push({
                name: attachment.name,
                path: `${safeTestId}/${attachment.name}`,
                contentType: attachment.contentType,
              })
              console.log(`[CrvyRprtr] Saved screenshot: ${destPath}`)
            } catch (error) {
              console.error(`[CrvyRprtr] Failed to save screenshot: ${attachment.path}`, error)
              savedAttachments.push({
                name: attachment.name,
                path: attachment.path,
                contentType: attachment.contentType,
              })
            }
          }),
        ),
    )
    return savedAttachments
  }
  private sanitizeId(id: string): string {
    return id.replace(/[^a-zA-Z0-9-_]/g, '_')
  }
  private async writeOfflineReport(): Promise<void> {
    if (this.runEvents.length === 0) console.log('[CrvyRprtr] No offline events to write')
    if (this.runEvents.length === 0) return
    try {
      const report = {
        version: 1,
        generatedAt: new Date().toISOString(),
        workers: this.workerIndex + 1,
        events: this.runEvents.map((event) => ({ ...event, timestamp: Date.now(), workerIndex: this.workerIndex })),
      }
      await writeFile(this.offlineReportPath, JSON.stringify(report, null, 2))
      console.log(`[CrvyRprtr] Wrote offline report: ${this.offlineReportPath}`)
    } catch (error) {
      console.error('[CrvyRprtr] Failed to write offline report:', error)
    }
  }
  private async writeStaticArtifact(): Promise<void> {
    try {
      await writeReportArtifact({
        events: this.runEvents,
        screenshotDir: this.screenshotDir,
        reportHtmlPath: this.reportHtmlPath,
      })
      console.log(`[CrvyRprtr] Wrote report artifact: ${this.reportHtmlPath}`)
    } catch (error) {
      console.error('[CrvyRprtr] Failed to write report artifact:', error)
    }
  }
  async onEnd(result: FullResult): Promise<void> {
    this.send({ type: 'run-end', data: { status: result.status } })
    await this.writeStaticArtifact()
    if (this.hadOfflineMode) await this.writeOfflineReport()
    await new Promise<void>((resolve) => {
      if (this.ws && this.ws.readyState !== WebSocket.CLOSED) {
        this.ws.onclose = (): void => {
          resolve()
        }
        setTimeout(() => {
          this.ws?.close()
          resolve()
        }, 1000)
        this.ws.close()
      } else resolve()
    })
  }
  private send(message: object): void {
    const event = message as { type?: string; data?: unknown }
    if (event.type === 'test-begin' || event.type === 'test-end' || event.type === 'run-end')
      this.runEvents.push({ type: event.type, data: event.data })
    const payload = JSON.stringify(message)
    if (!this.isOfflineMode) {
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(payload)
      else this.queue.push(payload)
    }
  }
}
export default CrvyRprtr
