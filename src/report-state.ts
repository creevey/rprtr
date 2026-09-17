import { join } from 'path'

import type { RunEnvironments } from './browser-pins.ts'
import { isAnyAbsolutePath } from './path-utils.ts'
import {
  attachmentsToImages,
  copyVisualDeclarations,
  getDeclaredVisualNames,
  mapStatus,
  mergeDeclaredImages,
  parseImageAttachmentName,
} from './report-utils.ts'
import type { ScreenshotDeclaration } from './reporter-utils.ts'
import type { RunBeginData, TestBeginData, TestEndData } from './schemas.ts'
import { DISCOVERED_ID_PREFIX } from './server/vitest-discovery.ts'
import type { Images, TestData, TestResult } from './types.ts'

export interface MutableReportData {
  isRunning: boolean
  tests: Record<string, TestData>
  browsers: string[]
  isUpdateMode: boolean
  screenshotDir: string
  /** Effective browser environments keyed by project; empty when the reporter sent none. */
  environments: RunEnvironments
}

export interface MutableReportState {
  reportData: MutableReportData
  currentRunIds: Set<string>
}

export interface ApplyTestEndResult {
  test: TestData
  diffCount: number
}

type ReportStateTestEndData = TestEndData & {
  visualDeclarations?: readonly ScreenshotDeclaration[]
}

/**
 * Strips a test's run-scoped state — recorded results and approval — while
 * keeping its identity, so the sidebar keeps its shape and the test starts
 * from a clean slate. Callers set the status they want next.
 */
function clearTestRunState(test: TestData): void {
  delete test.results
  delete test.approved
  test.status = 'pending'
}

function countDiffImages(images: Partial<Record<string, Images>>): number {
  return Object.values(images).filter((img) => img?.diff !== null && img?.diff !== undefined).length
}

/**
 * Filesystem path of an image's actual artifact: the attachment's native path
 * when absolute (dev mode), or the content-addressed copy inside the report
 * screenshot dir when relative (CI mode).
 */
function actualAttachmentSourcePath(
  attachments: TestEndData['attachments'],
  imageName: string,
  screenshotDir: string,
): string | undefined {
  for (const attachment of attachments) {
    if (attachment.contentType !== 'image/png') continue
    const parsed = parseImageAttachmentName(attachment.name)
    if (parsed === null || parsed.baseName !== imageName || parsed.role !== 'actual') continue
    return isAnyAbsolutePath(attachment.path) ? attachment.path : join(screenshotDir, attachment.path)
  }
  return undefined
}

/**
 * Stamp reporter-asserted approval metadata onto built images. The source is
 * the image's actual artifact; expected-only first-run images (no actual) fall
 * back to the target itself — approving them is a same-file no-op that only
 * marks the test approved.
 */
function stampApprovalTargets(
  images: Partial<Record<string, Images>>,
  data: ReportStateTestEndData,
  screenshotDir: string,
): void {
  const approvalTargets = data.approvalTargets
  if (approvalTargets === undefined) return
  for (const [imageName, targetPath] of Object.entries(approvalTargets)) {
    const image = images[imageName]
    if (image === undefined) continue
    image.approveFromPath = actualAttachmentSourcePath(data.attachments, imageName, screenshotDir) ?? targetPath
    image.approveToPath = targetPath
  }
}

export function createMutableReportState(screenshotDir = './screenshots'): MutableReportState {
  return {
    reportData: {
      isRunning: false,
      tests: {},
      browsers: ['chromium'],
      isUpdateMode: false,
      screenshotDir,
      environments: {},
    },
    currentRunIds: new Set<string>(),
  }
}

/**
 * Sidebar-tree identity of a test: (fileTokens, titlePath, title, browser) —
 * the same slot discovery and streamed results occupy. A real run's
 * test-begin replaces the discovered placeholder sitting in this slot.
 */
function treeSlotIdentity(test: {
  fileTokens?: string[]
  titlePath?: string[]
  title: string
  browser: string
}): string {
  return [...(test.fileTokens ?? []), ...(test.titlePath ?? []), test.title, test.browser].join('\u0000')
}

/**
 * Removes the discovered placeholder occupying the same sidebar slot as the
 * incoming streamed test, so the tree never shows the test twice and the
 * streamed entry takes over the exact same position — the structure stays
 * stable during the run.
 */
function removeDiscoveredPlaceholder(tests: Record<string, TestData>, identity: string): Record<string, TestData> {
  for (const [candidateId, candidate] of Object.entries(tests)) {
    if (!candidateId.startsWith(DISCOVERED_ID_PREFIX)) continue
    if (
      treeSlotIdentity({
        fileTokens: candidate.fileTokens,
        titlePath: candidate.titlePath,
        title: candidate.title,
        browser: candidate.browser,
      }) === identity
    ) {
      const { [candidateId]: _placeholder, ...remaining } = tests
      return remaining
    }
  }
  return tests
}

/**
 * Clears the run-scoped state of every announced test that exists in the
 * report: the run about to start owns those tests' results and approvals.
 * Tests outside the announcement keep their recorded state — a filtered run
 * only supersedes the subset it executes.
 */
export function applyRunBeginEvent(state: MutableReportState, data: RunBeginData): void {
  for (const id of data.testIds) {
    const test = state.reportData.tests[id]
    if (test !== undefined) {
      clearTestRunState(test)
    }
  }
}

export function applyTestBeginEvent(state: MutableReportState, data: TestBeginData): TestData {
  const { id, title, titlePath, fileTokens, browser, projectName, location, provider } = data
  state.currentRunIds.add(id)
  const existing = state.reportData.tests[id]
  if (existing !== undefined) {
    // A re-run reuses the same id; start it fresh — no prior result or approval
    // may leak into the new run — and flip it to 'running' so the UI shows the
    // in-progress state instead of the previous run's status.
    clearTestRunState(existing)
    existing.status = 'running'
    return existing
  }

  state.reportData.tests = removeDiscoveredPlaceholder(
    state.reportData.tests,
    treeSlotIdentity({ fileTokens, titlePath, title: title ?? '', browser: browser ?? '' }),
  )

  const created: TestData = {
    id,
    titlePath: titlePath ?? [],
    ...(fileTokens === undefined ? {} : { fileTokens }),
    browser: browser ?? '',
    // Older reporters sent the raw project name in `browser` and had no
    // `projectName` field. Preserve that value for snapshot path resolution
    // when loading data produced by such reporters.
    projectName: projectName ?? browser ?? '',
    title: title ?? '',
    location,
    provider,
    status: 'running',
  }
  state.reportData.tests[id] = created
  return created
}

export function applyTestEndEvent(
  state: MutableReportState,
  data: ReportStateTestEndData,
  options: { screenshotsBaseUrl?: string } = {},
): ApplyTestEndResult | null {
  const test = state.reportData.tests[data.id]
  if (test === undefined) {
    return null
  }

  test.status = mapStatus(data.status)
  const resultStatus: TestResult['status'] =
    data.status === 'passed' ? 'success' : data.status === 'failed' ? 'failed' : 'pending'
  const visualDeclarations = copyVisualDeclarations(data.visualDeclarations)
  const images = mergeDeclaredImages(
    attachmentsToImages(data.attachments, options.screenshotsBaseUrl),
    getDeclaredVisualNames(data.visualNames, visualDeclarations),
  )
  stampApprovalTargets(images, data, state.reportData.screenshotDir)

  // New failure with diff images invalidates any prior approval.
  const diffCount = countDiffImages(images)
  const hasDiffs = diffCount > 0
  if (hasDiffs) {
    test.approved = null
  }

  test.results = [
    {
      status: resultStatus,
      retries: 0,
      images,
      visualDeclarations,
      error: data.error,
      duration: data.duration,
    },
  ]

  return {
    test,
    diffCount,
  }
}

export function finalizeRunEvent(
  state: MutableReportState,
  options: { preserveNonCurrent?: boolean } = {},
): { passed: number; failed: number; pending: number } {
  state.reportData.isRunning = false
  // A filtered run only covers a subset of tests; tests it did not touch must be
  // retained. Full runs cull anything not seen this run (handles deleted tests).
  if (options.preserveNonCurrent !== true) {
    state.reportData.tests = Object.fromEntries(
      Object.entries(state.reportData.tests).filter(([id]) => state.currentRunIds.has(id)),
    )
  }
  state.currentRunIds.clear()

  const runTests = Object.values(state.reportData.tests).filter((test): test is TestData => test !== undefined)
  return {
    passed: runTests.filter((test) => test.status === 'success').length,
    failed: runTests.filter((test) => test.status === 'failed').length,
    pending: runTests.filter((test) => test.status === 'pending').length,
  }
}
