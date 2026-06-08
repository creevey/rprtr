import { copyFile, mkdir, writeFile } from 'fs/promises'
import { dirname, join } from 'path'

import pLimit from 'p-limit'

import { log, logError } from './debug-log.ts'
import { writeReportArtifact } from './report-artifact.ts'
import type { AttachmentData } from './reporter-utils.ts'
import { resolveBaselineTargets } from './snapshot-path-resolver.ts'

const CURRENT_DIRECTORY_ARTIFACT_SEGMENT = '+dot+'
const PARENT_DIRECTORY_ARTIFACT_SEGMENT = '+dotdot+'
const MAX_CONCURRENT_FILE_OPS = 5
const SAFE_ARTIFACT_CHARACTER = /^[A-Za-z0-9._-]$/

export type RunEvent = { type: 'test-begin' | 'test-end' | 'run-end'; data: unknown }
export type BaselineResolverInput = Parameters<typeof resolveBaselineTargets>[0]
export type ResolvedBaselineTarget = ReturnType<typeof resolveBaselineTargets>[number]

export function encodeArtifactPathSegment(segment: string): string {
  if (segment === '.') return CURRENT_DIRECTORY_ARTIFACT_SEGMENT
  if (segment === '..') return PARENT_DIRECTORY_ARTIFACT_SEGMENT
  return Array.from(segment, (character) =>
    SAFE_ARTIFACT_CHARACTER.test(character) ? character : encodeURIComponent(character),
  ).join('')
}

export function safeArtifactPath(name: string): string {
  return name.split('/').map(encodeArtifactPathSegment).join('/')
}

export function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9-_]/g, '_')
}

export async function copyResolvedBaseline(
  safeTestId: string,
  testScreenshotDir: string,
  target: ResolvedBaselineTarget,
  savedAttachments: AttachmentData[],
): Promise<void> {
  const attachmentName = `${target.attachmentBaseName}-expected.png`
  const artifactPath = safeArtifactPath(attachmentName)
  const destPath = join(testScreenshotDir, artifactPath)
  try {
    await mkdir(dirname(destPath), { recursive: true })
    await copyFile(target.snapshotPath, destPath)
    savedAttachments.push({ name: attachmentName, path: `${safeTestId}/${artifactPath}`, contentType: 'image/png' })
    log(`[CrvyRprtr] Attached baseline: ${target.snapshotPath}`)
  } catch {}
}

export async function saveAttachments(
  screenshotDir: string,
  testId: string,
  result: { attachments: { contentType?: string; path?: string; name: string }[] },
): Promise<AttachmentData[]> {
  const savedAttachments: AttachmentData[] = []
  const safeTestId = sanitizeId(testId)
  const testScreenshotDir = join(screenshotDir, safeTestId)
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
            const artifactPath = safeArtifactPath(attachment.name)
            const destPath = join(testScreenshotDir, artifactPath)
            await mkdir(dirname(destPath), { recursive: true })
            await copyFile(attachment.path, destPath)
            savedAttachments.push({
              name: attachment.name,
              path: `${safeTestId}/${artifactPath}`,
              contentType: attachment.contentType ?? 'image/png',
            })
            log(`[CrvyRprtr] Saved screenshot: ${destPath}`)
          } catch (error) {
            logError(`[CrvyRprtr] Failed to save screenshot: ${attachment.path}`, error)
            savedAttachments.push({
              name: attachment.name,
              path: attachment.path,
              contentType: attachment.contentType ?? 'image/png',
            })
          }
        }),
      ),
  )
  return savedAttachments
}

export function rewriteTestEndAttachments(runEvents: RunEvent[], testId: string, attachments: AttachmentData[]): void {
  for (const event of runEvents) {
    const { data } = event
    if (
      event.type === 'test-end' &&
      typeof data === 'object' &&
      data !== null &&
      'id' in data &&
      'attachments' in data &&
      (data as { id: unknown }).id === testId
    ) {
      Object.assign(data, { attachments })
    }
  }
}

export async function writeOfflineReport(
  runEvents: RunEvent[],
  offlineReportPath: string,
  workerIndex: number,
): Promise<void> {
  if (runEvents.length === 0) {
    log('[CrvyRprtr] No offline events to write')
    return
  }
  try {
    const report = {
      version: 1,
      generatedAt: new Date().toISOString(),
      workers: workerIndex + 1,
      events: runEvents.map((event) => ({ ...event, timestamp: Date.now(), workerIndex })),
    }
    await writeFile(offlineReportPath, JSON.stringify(report, null, 2))
    log(`[CrvyRprtr] Wrote offline report: ${offlineReportPath}`)
  } catch (error) {
    logError('[CrvyRprtr] Failed to write offline report:', error)
  }
}

export async function writeStaticArtifact(
  runEvents: RunEvent[],
  screenshotDir: string,
  reportHtmlPath: string,
): Promise<void> {
  try {
    await writeReportArtifact({ events: runEvents, screenshotDir, reportHtmlPath })
    log(`[CrvyRprtr] Wrote report artifact: ${reportHtmlPath}`)
  } catch (error) {
    logError('[CrvyRprtr] Failed to write report artifact:', error)
  }
}
