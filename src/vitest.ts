import { isAbsolute, relative, resolve } from 'path'

import pLimit from 'p-limit'
import type { Reporter, TestCase, TestProject, TestRunEndReason, Vitest } from 'vitest/node'

import { log, logError } from './debug-log.ts'
import { saveAttachments } from './reporter-artifact-ops.ts'
import type { AttachmentData } from './reporter-utils.ts'
import { ReporterTransport, type ReporterTransportOptions } from './transport.ts'
import {
  buildAttachmentPath,
  buildReferencePath,
  getBrowserName,
  getImageNameFromPath,
  getTitlePath,
  mapVitestStatus,
  parseVitestScreenshotError,
  type ParsedVitestImagePaths,
} from './vitest-helpers.ts'

type TestCaseArtifact = ReturnType<TestCase['artifacts']>[number]
export type VisualRegressionArtifact = Extract<TestCaseArtifact, { type: 'internal:toMatchScreenshot' }>

type ArtifactRole = 'expected' | 'actual' | 'diff'

const ARTIFACT_ROLES: readonly ArtifactRole[] = ['expected', 'actual', 'diff']

export interface CrvyRprtrVitestReporterOptions extends ReporterTransportOptions {
  /** Overrides vitest's default reference directory (`__screenshots__`). */
  referenceDir?: string
  /** Overrides vitest's default attachments directory (`.vitest-attachments`). */
  attachmentsDir?: string
}

interface PendingVitestArtifact {
  testId: string
  nativeAttachments: AttachmentData[]
  eventData: { attachments: AttachmentData[] }
}

interface VisualArtifactEntry {
  imageName: string
  paths: Partial<Record<ArtifactRole, string>>
}

function isVisualRegressionArtifact(artifact: TestCaseArtifact): artifact is VisualRegressionArtifact {
  return artifact.type === 'internal:toMatchScreenshot'
}

function attachmentRole(attachmentName: string): ArtifactRole | null {
  if (attachmentName === 'reference') return 'expected'
  if (attachmentName === 'actual' || attachmentName === 'diff') return attachmentName
  return null
}

function firstDefined<T>(...values: readonly (T | undefined)[]): T | undefined {
  return values.find((value): value is T => value !== undefined)
}

function mapRunReason(reason: TestRunEndReason): 'passed' | 'failed' | 'skipped' {
  switch (reason) {
    case 'passed':
      return 'passed'
    case 'failed':
    case 'interrupted':
      return 'failed'
  }
}

const MAX_CONCURRENT_FILE_OPS = 5

function isPathWithin(child: string, parent: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * Vitest Browser Mode reporter on the shared rprtr transport. Reports
 * `toMatchScreenshot` artifacts (reference/actual/diff) as rprtr image
 * attachments: dev mode serves vitest's native files via the server's
 * `/file/` route (zero-copy), CI mode copies them content-addressed into
 * `screenshotDir` for portable static/offline reports.
 *
 * `approvalTargets` is a reserved payload field name for the follow-up
 * approval change; it is intentionally not emitted yet.
 */
export class CrvyRprtrVitestReporter implements Reporter {
  private readonly transport: ReporterTransport
  private readonly screenshotDir: string
  private readonly ci: boolean
  private readonly referenceDir: string
  private readonly attachmentsDir: string
  private projectRoot = process.cwd()
  private transportStarted = false
  private pendingArtifacts: PendingVitestArtifact[] = []

  constructor(options: CrvyRprtrVitestReporterOptions = {}) {
    this.transport = new ReporterTransport(options)
    this.screenshotDir = this.transport.screenshotDir
    this.ci = this.transport.ci
    this.referenceDir = options.referenceDir ?? '__screenshots__'
    this.attachmentsDir = options.attachmentsDir ?? '.vitest-attachments'
  }

  onInit(vitest: Vitest): void {
    this.projectRoot = vitest.config.root
  }

  onBrowserInit(project: TestProject): void {
    this.ensureTransportStarted()
    if (!this.ci) this.sendRegister(project)
  }

  onTestRunStart(): void {
    log('[CrvyRprtrVitestReporter] Starting vitest run')
    this.ensureTransportStarted()
  }

  onTestCaseReady(testCase: TestCase): void {
    this.send({
      type: 'test-begin',
      data: {
        id: testCase.id,
        title: testCase.name,
        titlePath: getTitlePath(testCase),
        browser: getBrowserName(testCase),
        projectName: testCase.project.name,
        location: {
          file: testCase.module.moduleId,
          line: testCase.location?.line ?? 1,
          column: testCase.location?.column,
        },
        provider: 'vitest',
      },
    })
  }

  onTestCaseResult(testCase: TestCase): void {
    const result = testCase.result()
    const browser = getBrowserName(testCase)
    const firstError = result.errors?.[0]
    const parsedImagePaths = parseVitestScreenshotError(firstError?.message, browser)
    const entries = this.collectVisualEntries(testCase, browser, parsedImagePaths)
    const attachments = this.buildAttachmentEntries(entries)
    const data = {
      id: testCase.id,
      title: testCase.name,
      status: mapVitestStatus(result.state),
      attachments,
      visualNames: [...new Set(entries.map(({ imageName }) => imageName))],
      error: firstError?.message,
      duration: testCase.diagnostic()?.duration,
    }

    try {
      if (this.ci) {
        this.pendingArtifacts.push({ testId: testCase.id, nativeAttachments: attachments, eventData: data })
      }
      this.send({ type: 'test-end', data })
    } catch (error: unknown) {
      logError('[CrvyRprtrVitestReporter] Failed to report test result:', error)
    }
  }

  async onTestRunEnd(
    _testModules: ReadonlyArray<unknown>,
    _unhandledErrors: ReadonlyArray<unknown>,
    reason: TestRunEndReason,
  ): Promise<void> {
    await this.transport.finish({ status: mapRunReason(reason) }, () => this.flushPendingArtifacts())
  }

  private ensureTransportStarted(): void {
    if (this.transportStarted) return
    this.transportStarted = true
    this.transport.start()
  }

  private send(message: object): void {
    this.transport.send(message)
  }

  /**
   * Allowlist the directories whose files the server may serve over `/file/`.
   * Attachments are centralized by vitest (precise root). References scatter
   * under `<any test file dir>/<referenceDir>/`, so an in-root reference dir is
   * covered by registering the vitest project root itself; an explicit
   * reference dir outside the root registers that external directory.
   */
  private sendRegister(project: TestProject): void {
    const root = this.projectRoot
    const configuredAttachmentsDir = project.config.attachmentsDir
    const resolvedReferenceDir = resolve(root, this.referenceDir)
    this.send({
      type: 'register',
      data: {
        vitestAttachmentsDir:
          this.attachmentsDir === '.vitest-attachments' && typeof configuredAttachmentsDir === 'string'
            ? configuredAttachmentsDir
            : resolve(root, this.attachmentsDir),
        vitestReferenceDir: isPathWithin(resolvedReferenceDir, root) ? root : resolvedReferenceDir,
      },
    })
  }

  private buildAttachmentEntries(entries: readonly VisualArtifactEntry[]): AttachmentData[] {
    return entries.flatMap(({ imageName, paths }) =>
      ARTIFACT_ROLES.map((role) => ({ role, path: paths[role] }))
        .filter((entry): entry is { role: ArtifactRole; path: string } => entry.path !== undefined)
        .map(({ role, path }) => ({ name: `${imageName}-${role}.png`, path, contentType: 'image/png' })),
    )
  }

  private reconstructPath(testCase: TestCase, browser: string, imageName: string, role: ArtifactRole): string {
    const testFile = testCase.module.moduleId
    return role === 'expected'
      ? buildReferencePath(this.projectRoot, this.referenceDir, testFile, imageName, browser)
      : buildAttachmentPath(this.projectRoot, this.attachmentsDir, testFile, imageName, browser, role)
  }

  private resolveEntryPaths(
    testCase: TestCase,
    browser: string,
    artifact: VisualRegressionArtifact,
    parsedImagePaths: readonly ParsedVitestImagePaths[],
  ): VisualArtifactEntry | null {
    const seedPath = firstDefined(
      parsedImagePaths[0]?.referencePath,
      parsedImagePaths[0]?.actualPath,
      parsedImagePaths[0]?.diffPath,
      artifact.attachments.find((attachment) => attachment.path !== undefined)?.path,
    )
    if (seedPath === undefined) return null

    const imageName = getImageNameFromPath(seedPath, browser)
    const parsed = parsedImagePaths.find((image) => image.imageName === imageName)

    // First-run baseline-only artifacts (no actual/diff evidence) must not gain
    // reconstructed roles; reconstruction only fills locations for failed
    // comparisons where the roles are known to exist on disk.
    const hasComparisonEvidence =
      artifact.attachments.some((candidate) => {
        const role = attachmentRole(candidate.name)
        return role !== null && role !== 'expected'
      }) ||
      parsed?.actualPath !== undefined ||
      parsed?.diffPath !== undefined

    const paths: Partial<Record<ArtifactRole, string>> = {}
    for (const role of ARTIFACT_ROLES) {
      const attachment = artifact.attachments.find((candidate) => attachmentRole(candidate.name) === role)
      const parsedPath =
        role === 'expected' ? parsed?.referencePath : role === 'actual' ? parsed?.actualPath : parsed?.diffPath
      paths[role] = firstDefined(
        parsedPath,
        attachment?.path,
        hasComparisonEvidence ? this.reconstructPath(testCase, browser, imageName, role) : undefined,
      )
    }
    return { imageName, paths }
  }

  private collectVisualEntries(
    testCase: TestCase,
    browser: string,
    parsedImagePaths: readonly ParsedVitestImagePaths[],
  ): VisualArtifactEntry[] {
    const entries: VisualArtifactEntry[] = []
    for (const artifact of testCase.artifacts()) {
      if (!isVisualRegressionArtifact(artifact)) continue
      const entry = this.resolveEntryPaths(testCase, browser, artifact, parsedImagePaths)
      if (entry !== null) entries.push(entry)
    }
    return entries
  }

  private async flushPendingArtifacts(): Promise<void> {
    const limit = pLimit(MAX_CONCURRENT_FILE_OPS)
    await Promise.all(
      this.pendingArtifacts.map((pending) =>
        limit(async () => {
          pending.eventData.attachments = await saveAttachments(this.screenshotDir, pending.testId, {
            attachments: pending.nativeAttachments,
          })
        }),
      ),
    )
    this.pendingArtifacts = []
  }
}

export default CrvyRprtrVitestReporter
