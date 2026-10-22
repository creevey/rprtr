import type { FullProject, TestCase, TestResult } from '@playwright/test/reporter'

import type { FontRendering } from './rendering.ts'
import { type AttachmentData, describeTitlePath } from './reporter-utils.ts'
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
  /**
   * Text antialiasing for the browsers this run launches. `grayscale` (default)
   * pins it so baselines compare across environments; `inherit` leaves the
   * environment's own rendering alone. Matches the option both run modes expose.
   */
  fontRendering?: FontRendering
}

export interface PendingPortableArtifact {
  testId: string
  status: TestResult['status']
  resolvedTargets: ResolvedBaselineTarget[]
  nativeAttachments: AttachmentData[]
  eventData: { attachments: AttachmentData[] }
}

export interface TestBeginEvent {
  type: 'test-begin'
  data: {
    id: string
    title: string
    titlePath: string[]
    fileTokens: string[]
    browser: string
    projectName: string
    location: { file: string; line: number; column: number | undefined }
  }
}

export function testBeginEvent(
  test: TestCase,
  project: FullProject | undefined,
  fileTokens: string[],
  browser: string,
): TestBeginEvent {
  return {
    type: 'test-begin',
    data: {
      id: test.id,
      title: test.title,
      titlePath: describeTitlePath(test),
      fileTokens,
      browser,
      projectName: project?.name ?? '',
      location: { file: test.location.file, line: test.location.line, column: test.location.column },
    },
  }
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
