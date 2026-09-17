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
  /**
   * What to do when a declared browser pin drifts from the effective browser
   * build: `warn` (default) annotates the run, `fail` fails it at reporter init.
   * Unpinned and unverifiable projects never fail.
   */
  browserPinPolicy?: 'warn' | 'fail'
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
