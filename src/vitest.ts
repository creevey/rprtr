import { existsSync } from 'fs'
import { isAbsolute, relative, resolve } from 'path'

import pLimit from 'p-limit'
import type { Reporter, ResolvedConfig, TestCase, TestProject, TestRunEndReason, Vitest } from 'vitest/node'

import { log, logError } from './debug-log.ts'
import { saveAttachments } from './reporter-artifact-ops.ts'
import type { AttachmentData, ScreenshotDeclaration } from './reporter-utils.ts'
import { ReporterTransport, type ReporterTransportOptions } from './transport.ts'
import {
  approvalTargetsFromEntries,
  buildAttachmentEntries,
  collectVisualEntries,
  mergeVisualEntries,
  type VisualArtifactEntry,
  type VitestArtifactLayout,
} from './vitest-artifacts.ts'
import { extractVitestScreenshots, loadTestSource, type VitestDeclarationContext } from './vitest-declarations.ts'
import {
  getBrowserName,
  getTitlePath,
  mapVitestStatus,
  parseVitestScreenshotError,
  relativeFileTokens,
} from './vitest-helpers.ts'

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

interface PassingVisualData {
  readonly entries: VisualArtifactEntry[]
  readonly declarations: ScreenshotDeclaration[]
}

const NO_PASSING_VISUAL_DATA: PassingVisualData = { entries: [], declarations: [] }

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

/**
 * The resolved config file path, or undefined for inline programmatic
 * configuration. Vitest's merged test config may or may not surface Vite's
 * `configFile` depending on how the config was merged, so check the test
 * config first and fall back to the underlying Vite dev-server config.
 */
function resolveVitestConfigFile(vitest: Vitest): string | undefined {
  const fromTestConfig = (vitest.config as ResolvedConfig & { configFile?: string | false }).configFile
  if (typeof fromTestConfig === 'string') return fromTestConfig
  const fromViteConfig = vitest.vite.config.configFile
  return typeof fromViteConfig === 'string' ? fromViteConfig : undefined
}

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
  private configFile: string | undefined
  private transportStarted = false
  private pendingArtifacts: PendingVitestArtifact[] = []
  private moduleSources = new Map<string, string | null>()

  constructor(options: CrvyRprtrVitestReporterOptions = {}) {
    this.transport = new ReporterTransport(options)
    this.screenshotDir = this.transport.screenshotDir
    this.ci = this.transport.ci
    this.referenceDir = options.referenceDir ?? '__screenshots__'
    this.attachmentsDir = options.attachmentsDir ?? '.vitest-attachments'
  }

  onInit(vitest: Vitest): void {
    this.projectRoot = vitest.config.root
    this.configFile = resolveVitestConfigFile(vitest)
  }

  onBrowserInit(project: TestProject): void {
    this.ensureTransportStarted()
    if (!this.ci) this.sendRegister(project)
  }

  onTestRunStart(): void {
    log('[CrvyRprtrVitestReporter] Starting vitest run')
    this.ensureTransportStarted()
    // Watch-mode runs re-read edited sources; stale extraction input must go.
    this.moduleSources.clear()
  }

  onTestCaseReady(testCase: TestCase): void {
    this.send({
      type: 'test-begin',
      data: {
        id: testCase.id,
        title: testCase.name,
        titlePath: getTitlePath(testCase),
        // Root-relative file tokens match discovery's grouping so the sidebar
        // tree keeps the same shape before, during, and after a run.
        fileTokens: relativeFileTokens(this.projectRoot, testCase.module.moduleId),
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
    // Vitest records no screenshot artifacts for passing assertions, so the
    // reference must come from the test's own source declarations. Failing
    // tests keep their artifact/error-derived payload untouched.
    const passing = result.state === 'passed' ? this.passingVisualData(testCase, browser) : NO_PASSING_VISUAL_DATA
    const mergedEntries = mergeVisualEntries(entries, passing.entries)
    const attachments = buildAttachmentEntries(mergedEntries)
    const approvalTargets = approvalTargetsFromEntries(mergedEntries)
    const data = {
      id: testCase.id,
      title: testCase.name,
      status: mapVitestStatus(result.state),
      attachments,
      visualNames: [...new Set(mergedEntries.map(({ imageName }) => imageName))],
      ...(passing.declarations.length > 0 ? { visualDeclarations: passing.declarations } : {}),
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
        // Lets the server enable the UI run controls (vitest run --config …).
        // Omitted for inline programmatic config: the server keeps the run
        // buttons hidden when the config file path is unknown.
        ...(this.configFile === undefined ? {} : { configFile: this.configFile }),
        cwd: root,
        runner: 'vitest',
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

  /**
   * Declarations for a passing visual test, derived from its module source.
   * Only references that exist on disk are surfaced — a missing reference is
   * logged and omitted (Vitest's own first-run behavior reports it honestly).
   */
  private passingVisualData(testCase: TestCase, browser: string): PassingVisualData {
    const source = this.moduleSource(testCase.module.moduleId)
    if (source === null) return NO_PASSING_VISUAL_DATA

    const context: VitestDeclarationContext = {
      projectRoot: this.projectRoot,
      referenceDir: this.referenceDir,
      testFile: testCase.module.moduleId,
      browser,
    }
    const entries: VisualArtifactEntry[] = []
    const declarations: ScreenshotDeclaration[] = []
    for (const { declaration, imageName, referencePath } of extractVitestScreenshots(
      source,
      getTitlePath(testCase),
      testCase.name,
      context,
    )) {
      if (!existsSync(referencePath)) {
        log(
          `[CrvyRprtrVitestReporter] Missing reference for passing screenshot "${imageName}"; ` +
            'the image is not synthesized: ' +
            referencePath,
        )
        continue
      }
      entries.push({ imageName, paths: { expected: referencePath } })
      declarations.push(declaration)
    }
    return { entries, declarations }
  }

  private moduleSource(moduleId: string): string | null {
    const cached = this.moduleSources.get(moduleId)
    if (cached !== undefined) return cached
    const source = loadTestSource(moduleId)
    this.moduleSources.set(moduleId, source)
    return source
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
