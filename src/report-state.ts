import { join } from 'path'

import { isAnyAbsolutePath } from './path-utils.ts'
import {
  attachmentsToImages,
  classifyImage,
  copyVisualDeclarations,
  getDeclaredVisualNames,
  mapStatus,
  mergeDeclaredImages,
  parseImageAttachmentName,
} from './report-utils.ts'
import type { ScreenshotDeclaration } from './reporter-utils.ts'
import type { TestBeginData, TestEndData } from './schemas.ts'
import type { Images, TestData, TestResult } from './types.ts'

export interface MutableReportData {
  isRunning: boolean
  tests: Record<string, TestData>
  browsers: string[]
  isUpdateMode: boolean
  screenshotDir: string
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

function isCurrentArtifact(image: Images | undefined): boolean {
  return image?.actual !== undefined || image?.expect !== undefined || image?.diff !== undefined
}

function isReusablePassingImage(image: Images): boolean {
  const source = image.source ?? classifyImage(image)
  return source === 'baseline-only'
}

function hasReusablePassingImages(images: Partial<Record<string, Images>>): boolean {
  return Object.values(images).some((img) => img !== null && img !== undefined && isReusablePassingImage(img))
}

function preservePreviousPassingImages(
  test: TestData,
  status: TestEndData['status'],
  images: Partial<Record<string, Images>>,
): Partial<Record<string, Images>> {
  if (status !== 'passed') {
    return images
  }

  const previousImages = test.results?.[0]?.images ?? {}
  if (!hasReusablePassingImages(previousImages)) {
    return images
  }

  return Object.entries(previousImages).reduce((currentImages, [name, previousImage]) => {
    if (
      !Object.hasOwn(currentImages, name) ||
      previousImage === undefined ||
      !isReusablePassingImage(previousImage) ||
      isCurrentArtifact(currentImages[name])
    ) {
      return currentImages
    }

    return {
      ...currentImages,
      [name]: {
        expect: previousImage.expect,
        source: 'baseline-only',
      },
    }
  }, images)
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
    },
    currentRunIds: new Set<string>(),
  }
}

export function applyTestBeginEvent(state: MutableReportState, data: TestBeginData): TestData {
  const { id, title, titlePath, browser, projectName, location, provider } = data
  state.currentRunIds.add(id)
  const existing = state.reportData.tests[id]
  if (existing !== undefined) {
    // A re-run reuses the same id; flip it back to 'running' so the UI shows
    // the in-progress state instead of the previous run's status. Prior results
    // stay intact until the new run's test-end arrives.
    existing.status = 'running'
    return existing
  }

  const created: TestData = {
    id,
    titlePath: titlePath ?? [],
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
  const images = preservePreviousPassingImages(
    test,
    data.status,
    mergeDeclaredImages(
      attachmentsToImages(data.attachments, options.screenshotsBaseUrl),
      getDeclaredVisualNames(data.visualNames, visualDeclarations),
    ),
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
