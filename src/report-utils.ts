import { isAbsolute } from 'path'

import type { ScreenshotDeclaration } from './reporter-utils.ts'
import type { Attachment } from './schemas.ts'
import type { Images, TestData, VisualSource } from './types.ts'

function normalizeScreenshotsBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`
}

export function classifyImage(image: Images): VisualSource {
  if (image.actual !== undefined || image.diff !== undefined) {
    return 'comparison'
  }

  if (image.expect !== undefined) {
    return 'baseline-only'
  }

  return 'declared-only'
}

function withImageSource(image: Images): Images {
  return {
    ...image,
    source: classifyImage(image),
  }
}

export function getDeclaredVisualNames(
  visualNames: readonly string[],
  visualDeclarations: readonly ScreenshotDeclaration[] | undefined,
): readonly string[] {
  return visualDeclarations?.map(({ visualName }) => visualName) ?? visualNames
}

export function copyVisualDeclarations(
  visualDeclarations: readonly ScreenshotDeclaration[] | undefined,
): readonly ScreenshotDeclaration[] | undefined {
  return visualDeclarations?.map((visualDeclaration) => ({ ...visualDeclaration }))
}

export function mergeDeclaredImages(
  images: Partial<Record<string, Images>>,
  visualNames: readonly string[],
): Partial<Record<string, Images>> {
  const names = new Set([...Object.keys(images), ...visualNames])

  return Object.fromEntries(
    Array.from(names, (name) => {
      const current = images[name] ?? {}
      return [name, withImageSource(current)]
    }),
  )
}

export function attachmentsToImages(
  attachments: Attachment[],
  screenshotsBaseUrl = '/screenshots/',
): Partial<Record<string, Images>> {
  const images: Partial<Record<string, Images>> = {}
  const baseUrl = normalizeScreenshotsBaseUrl(screenshotsBaseUrl)

  for (const attachment of attachments) {
    if (attachment.contentType !== 'image/png') continue
    const match = attachment.name.match(/^(.+?)-(actual|expected|diff)(?:\.png)?$/)
    if (match === null) continue
    const baseName = match[1]
    const role = match[2]
    if (baseName === null || baseName === undefined || role === null || role === undefined) continue
    images[baseName] ??= {}
    const url = isAbsolute(attachment.path)
      ? `/file/${encodeURIComponent(attachment.path)}`
      : `${baseUrl}${attachment.path}`
    const img = images[baseName]
    if (img !== null && img !== undefined) {
      if (role === 'actual') img.actual = url
      else if (role === 'expected') img.expect = url
      else if (role === 'diff') img.diff = url
    }
  }

  // For passing comparisons (has both actual and expected but no diff), drop the
  // expect — it matched so there is nothing to review, keep only actual.
  // A lone expected (baseline-only, no actual) is kept for display as-is.
  for (const key of Object.keys(images)) {
    const img = images[key]
    if (img?.actual !== undefined && img?.expect !== undefined && img?.diff === undefined) {
      delete img.expect
    }
  }

  return mergeDeclaredImages(images, [])
}

export function mapStatus(status: 'passed' | 'failed' | 'skipped'): TestData['status'] {
  switch (status) {
    case 'passed':
      return 'success'
    case 'failed':
      return 'failed'
    case 'skipped':
      return 'pending'
    default:
      return 'unknown'
  }
}
