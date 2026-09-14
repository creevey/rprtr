import { isAbsolute, relative, resolve } from 'path'

import pLimit from 'p-limit'
import type { Reporter, TestCase, TestProject, TestRunEndReason, Vitest } from 'vitest/node'

import { log, logError } from './debug-log.ts'
import { saveAttachments } from './reporter-artifact-ops.ts'
import type { AttachmentData } from './reporter-utils.ts'
import { ReporterTransport, type ReporterTransportOptions } from './transport.ts'
import {
  approvalTargetsFromEntries,
  buildAttachmentEntries,
  collectVisualEntries,
  type VitestArtifactLayout,
} from './vitest-artifacts.ts'
import { getBrowserName, getTitlePath, mapVitestStatus, parseVitestScreenshotError } from './vitest-helpers.ts'

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
 * Each test-end payload carries `approvalTargets` — the reference path per
 * screenshot — so the server can approve Vitest baselines without snapshot
 * resolution. Playwright's reporter omits the field and keeps resolving
 * baselines server-side.
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
    const entries = collectVisualEntries(this.artifactLayout(), testCase, browser, parsedImagePaths)
    const attachments = buildAttachmentEntries(entries)
    const approvalTargets = approvalTargetsFromEntries(entries)
    const data = {
      id: testCase.id,
      title: testCase.name,
      status: mapVitestStatus(result.state),
      attachments,
      visualNames: [...new Set(entries.map(({ imageName }) => imageName))],
      ...(approvalTargets === undefined ? {} : { approvalTargets }),
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

  private artifactLayout(): VitestArtifactLayout {
    return {
      projectRoot: this.projectRoot,
      referenceDir: this.referenceDir,
      attachmentsDir: this.attachmentsDir,
    }
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
