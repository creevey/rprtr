import type { TestCase } from 'vitest/node'

import type { AttachmentData } from './reporter-utils.ts'
import {
  buildAttachmentPath,
  buildReferencePath,
  getImageNameFromPath,
  type ParsedVitestImagePaths,
} from './vitest-helpers.ts'

type TestCaseArtifact = ReturnType<TestCase['artifacts']>[number]
export type VisualRegressionArtifact = Extract<TestCaseArtifact, { type: 'internal:toMatchScreenshot' }>

export type ArtifactRole = 'expected' | 'actual' | 'diff'

const ARTIFACT_ROLES: readonly ArtifactRole[] = ['expected', 'actual', 'diff']

export interface VisualArtifactEntry {
  imageName: string
  paths: Partial<Record<ArtifactRole, string>>
}

export interface VitestArtifactLayout {
  projectRoot: string
  referenceDir: string
  attachmentsDir: string
}

export function isVisualRegressionArtifact(artifact: TestCaseArtifact): artifact is VisualRegressionArtifact {
  return artifact.type === 'internal:toMatchScreenshot'
}

export function attachmentRole(attachmentName: string): ArtifactRole | null {
  if (attachmentName === 'reference') return 'expected'
  if (attachmentName === 'actual' || attachmentName === 'diff') return attachmentName
  return null
}

/**
 * The single datum the reporter uniquely knows: each image's baseline
 * (reference) file path. The server stamps these onto report images so
 * approval copies the actual onto the reporter-declared baseline instead of
 * relying on Playwright-only snapshot resolution.
 */
export function approvalTargetsFromEntries(
  entries: readonly VisualArtifactEntry[],
): Record<string, string> | undefined {
  const targets: Record<string, string> = {}
  for (const { imageName, paths } of entries) {
    const referencePath = paths.expected
    if (referencePath !== undefined) {
      targets[imageName] = referencePath
    }
  }
  return Object.keys(targets).length > 0 ? targets : undefined
}

export function buildAttachmentEntries(entries: readonly VisualArtifactEntry[]): AttachmentData[] {
  return entries.flatMap(({ imageName, paths }) =>
    ARTIFACT_ROLES.map((role) => ({ role, path: paths[role] }))
      .filter((entry): entry is { role: ArtifactRole; path: string } => entry.path !== undefined)
      .map(({ role, path }) => ({ name: `${imageName}-${role}.png`, path, contentType: 'image/png' })),
  )
}

/**
 * Artifact-derived entries (failures) win; source-extracted entries (passing
 * assertions) only fill image names that artifacts did not already provide.
 */
export function mergeVisualEntries(
  artifactEntries: readonly VisualArtifactEntry[],
  extractedEntries: readonly VisualArtifactEntry[],
): VisualArtifactEntry[] {
  const knownImageNames = new Set(artifactEntries.map(({ imageName }) => imageName))
  return [...artifactEntries, ...extractedEntries.filter(({ imageName }) => !knownImageNames.has(imageName))]
}

function reconstructPath(
  layout: VitestArtifactLayout,
  testCase: TestCase,
  browser: string,
  imageName: string,
  role: ArtifactRole,
): string {
  const testFile = testCase.module.moduleId
  return role === 'expected'
    ? buildReferencePath(layout.projectRoot, layout.referenceDir, testFile, imageName, browser)
    : buildAttachmentPath(layout.projectRoot, layout.attachmentsDir, testFile, imageName, browser, role)
}

function resolveEntryPaths(
  layout: VitestArtifactLayout,
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
      hasComparisonEvidence ? reconstructPath(layout, testCase, browser, imageName, role) : undefined,
    )
  }
  return { imageName, paths }
}

export function collectVisualEntries(
  layout: VitestArtifactLayout,
  testCase: TestCase,
  browser: string,
  parsedImagePaths: readonly ParsedVitestImagePaths[],
): VisualArtifactEntry[] {
  const entries: VisualArtifactEntry[] = []
  for (const artifact of testCase.artifacts()) {
    if (!isVisualRegressionArtifact(artifact)) continue
    const entry = resolveEntryPaths(layout, testCase, browser, artifact, parsedImagePaths)
    if (entry !== null) entries.push(entry)
  }
  return entries
}

function firstDefined<T>(...values: readonly (T | undefined)[]): T | undefined {
  return values.find((value): value is T => value !== undefined)
}
