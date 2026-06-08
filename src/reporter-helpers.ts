import type { TestResult } from '@playwright/test/reporter'

import type { AttachmentData } from './reporter-utils.ts'
import type { ResolvedBaselineTarget } from './snapshot-path-resolver.ts'

export interface CrvyRprtrOptions {
  serverUrl?: string
  screenshotDir?: string
  offlineReportPath?: string
  reportHtmlPath?: string
  playwrightSnapshotDir?: string
  playwrightSnapshotPathTemplate?: string
  playwrightToHaveScreenshotPathTemplate?: string
  ci?: boolean
}

export interface PendingPortableArtifact {
  testId: string
  status: TestResult['status']
  resolvedTargets: ResolvedBaselineTarget[]
  nativeAttachments: AttachmentData[]
  eventData: { attachments: AttachmentData[] }
}

export function collectNativeImageAttachments(result: TestResult): AttachmentData[] {
  return result.attachments
    .filter(
      (attachment): attachment is typeof attachment & { path: string } =>
        attachment.contentType === 'image/png' && attachment.path !== undefined,
    )
    .map((attachment) => ({
      name: attachment.name,
      path: attachment.path,
      contentType: attachment.contentType,
    }))
}
