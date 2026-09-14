import { existsSync } from 'fs'
import { mkdir } from 'fs/promises'
import { dirname, join } from 'path'

import type {
  FullConfig,
  FullProject,
  FullResult,
  Reporter,
  Suite,
  TestCase,
  TestResult,
} from '@playwright/test/reporter'
import pLimit from 'p-limit'

import { log } from './debug-log.ts'
import { copyResolvedBaseline, sanitizeId, saveAttachments } from './reporter-artifact-ops.ts'
import {
  collectNativeImageAttachments,
  type CrvyRprtrOptions,
  type PendingPortableArtifact,
} from './reporter-helpers.ts'
import { type AttachmentData, type ScreenshotDeclaration, extractScreenshotDeclarations } from './reporter-utils.ts'
import {
  type ResolvedBaselineTarget,
  type SnapshotResolverInput,
  resolveBaselineTargets,
  withResolvedVisualNames,
} from './snapshot-path-resolver.ts'
import { ReporterTransport } from './transport.ts'

export type { CrvyRprtrOptions }

export class CrvyRprtr implements Reporter {
  private readonly transport: ReporterTransport
  private readonly serverUrl: string
  private readonly screenshotDir: string
  private configDir = process.cwd()
  private testMetadata = new Map<string, { reporterTitlePath: string[] }>()
  private playwrightSnapshotDir?: string
  private playwrightSnapshotPathTemplate?: string
  private playwrightToHaveScreenshotPathTemplate?: string
  private readonly ci: boolean
  private readonly portableArtifacts = process.env.CRVY_RPRTR_PORTABLE_ARTIFACTS === '1'
  private pendingArtifacts: PendingPortableArtifact[] = []

  constructor(options: CrvyRprtrOptions = {}) {
    this.transport = new ReporterTransport(options)
    this.serverUrl = this.transport.serverUrl
    this.screenshotDir = this.transport.screenshotDir
    this.ci = this.transport.ci
    this.playwrightSnapshotDir = options.playwrightSnapshotDir
    this.playwrightSnapshotPathTemplate = options.playwrightSnapshotPathTemplate
    this.playwrightToHaveScreenshotPathTemplate = options.playwrightToHaveScreenshotPathTemplate
  }

  onBegin(config: FullConfig, suite: Suite): void {
    this.configDir = config.configFile === undefined ? config.rootDir : dirname(config.configFile)
    log(`[CrvyRprtr] Starting run with ${suite.allTests().length} tests`)
    this.transport.start()
    if (!this.ci) this.sendRegister(config)
  }

  private connect(): void {
    this.transport.connect()
  }

  private send(message: object): void {
    this.transport.send(message)
  }

  private sendRegister(config: FullConfig): void {
    const snapshotDir = this.playwrightSnapshotDir ?? config.projects[0]?.snapshotDir
    const testDir = this.playwrightSnapshotDir === undefined ? config.projects[0]?.testDir : undefined
    this.send({
      type: 'register',
      data: {
        playwrightSnapshotDir: typeof snapshotDir === 'string' ? snapshotDir : undefined,
        playwrightTestDir: typeof testDir === 'string' ? testDir : undefined,
        playwrightRootDir: typeof config.rootDir === 'string' ? config.rootDir : undefined,
        playwrightSnapshotPathTemplate: this.playwrightSnapshotPathTemplate,
        playwrightToHaveScreenshotPathTemplate: this.playwrightToHaveScreenshotPathTemplate,
        configFile: config.configFile,
        cwd: config.configFile === undefined ? process.cwd() : dirname(config.configFile),
      },
    })
  }

  private describeTitlePath(test: TestCase): string[] {
    const titlePath: string[] = []
    for (let suite: Suite | undefined = test.parent; suite?.type === 'describe'; suite = suite.parent)
      titlePath.unshift(suite.title)
    return titlePath
  }

  /** Resolves a non-empty browser label for UI display, falling back to the
   * configured browser engine since the raw project `name` is `""` for the
   * default project and devices spread `defaultBrowserType` into `use`. */
  private resolveBrowserLabel(project: FullProject | undefined): string {
    const name = project?.name
    if (name !== undefined && name !== '') return name
    return project?.use?.browserName ?? project?.use?.defaultBrowserType ?? 'chromium'
  }

  private reporterTitlePath(test: TestCase): string[] {
    // Index 1 is the raw Playwright project name ("" for the default project).
    return typeof test.titlePath === 'function'
      ? test.titlePath()
      : ['', test.parent.project()?.name ?? '', test.location.file, ...this.describeTitlePath(test), test.title]
  }

  onTestBegin(test: TestCase): void {
    const project = test.parent.project()
    this.testMetadata.set(test.id, {
      reporterTitlePath: this.reporterTitlePath(test),
    })
    this.send({
      type: 'test-begin',
      data: {
        id: test.id,
        title: test.title,
        titlePath: this.describeTitlePath(test),
        browser: this.resolveBrowserLabel(project),
        projectName: project?.name ?? '',
        location: { file: test.location.file, line: test.location.line, column: test.location.column },
      },
    })
  }

  async onTestEnd(test: TestCase, result: TestResult): Promise<void> {
    const reporterTitlePath = this.testMetadata.get(test.id)?.reporterTitlePath ?? this.reporterTitlePath(test)
    const screenshotDeclarations = withResolvedVisualNames(
      extractScreenshotDeclarations(result.steps),
      reporterTitlePath,
    )
    const nativeAttachments = collectNativeImageAttachments(result)
    const data = {
      id: test.id,
      title: test.title,
      status: result.status,
      attachments: nativeAttachments,
      visualNames: screenshotDeclarations.map(({ visualName }) => visualName),
      visualDeclarations: screenshotDeclarations,
      error: result.errors.length > 0 ? result.errors[0]?.message : undefined,
      duration: result.duration,
    }
    try {
      if (this.ci) {
        const baselineInput = result.status === 'passed' ? this.baselineInput(test, screenshotDeclarations) : null
        const resolvedTargets = baselineInput === null ? [] : resolveBaselineTargets(baselineInput)
        this.pendingArtifacts.push({
          testId: test.id,
          status: result.status,
          resolvedTargets,
          nativeAttachments,
          eventData: data,
        })
      } else if (this.portableArtifacts) {
        await mkdir(this.screenshotDir, { recursive: true })
        data.attachments = await saveAttachments(this.screenshotDir, test.id, { attachments: nativeAttachments })
      }
      this.send({ type: 'test-end', data })
    } finally {
      this.testMetadata.delete(test.id)
    }
  }

  private baselineInput(test: TestCase, shots: readonly ScreenshotDeclaration[]): SnapshotResolverInput | null {
    const project = test.parent.project()
    const snapshotDir = this.playwrightSnapshotDir ?? project?.snapshotDir
    if (project === undefined || typeof project.testDir !== 'string' || typeof snapshotDir !== 'string') return null
    return {
      testFile: test.location.file,
      reporterTitlePath: this.testMetadata.get(test.id)?.reporterTitlePath ?? this.reporterTitlePath(test),
      declarations: shots,
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

  private async copyBaselinesForTargets(
    testId: string,
    status: TestResult['status'],
    resolvedTargets: ResolvedBaselineTarget[],
    savedAttachments: AttachmentData[],
  ): Promise<void> {
    if (status !== 'passed' || resolvedTargets.length === 0) return
    const safeTestId = sanitizeId(testId)
    const testScreenshotDir = join(this.screenshotDir, safeTestId)
    const limit = pLimit(5)
    await Promise.all(
      resolvedTargets.map((target) =>
        limit(() => copyResolvedBaseline(safeTestId, testScreenshotDir, target, savedAttachments)),
      ),
    )
  }

  async onEnd(result: FullResult): Promise<void> {
    await this.transport.finish({ status: result.status }, () => this.flushPendingArtifacts())
  }

  private async flushPendingArtifacts(): Promise<void> {
    await mkdir(this.screenshotDir, { recursive: true })
    const limit = pLimit(10)
    await Promise.all(
      this.pendingArtifacts.map((pending) =>
        limit(async () => {
          const savedAttachments = await saveAttachments(this.screenshotDir, pending.testId, {
            attachments: pending.nativeAttachments,
          })
          await this.copyBaselinesForTargets(pending.testId, pending.status, pending.resolvedTargets, savedAttachments)
          pending.eventData.attachments = savedAttachments
        }),
      ),
    )
  }
}
export default CrvyRprtr
