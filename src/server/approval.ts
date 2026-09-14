import { existsSync } from 'fs'
import { isAbsolute, join } from 'path'

import { ApproveRequestBodySchema, safeParse } from '../schemas.ts'
import type { Images, TestData } from '../types.ts'
import { resolveBaselineSnapshotPath } from './artifact-routes.ts'
import { copyFilePortable } from './file-utils.ts'
import type { RoutesContext } from './routes.ts'

const APPROVAL_TARGET_ERROR = 'Could not resolve approval target'

interface ApprovalMetadata {
  fromPath: string
  toPath: string
}

/**
 * Reporter-asserted approval metadata (metadata-carrying providers such as
 * Vitest). Both paths must be absolute and the source must exist — the threat
 * model matches the resolver path: the reporter already supplies attachment
 * paths the server serves, and baseline targets are reporter-known files.
 * Targets are deliberately not constrained to artifact roots: metadata-carrying
 * baselines live in the reporter's project tree, which may not be a registered
 * root in artifact-dir/offline mode (consistent with resolver-trusted /baseline/).
 */
function approvalMetadataFromImage(image: Images | undefined): ApprovalMetadata | null {
  const fromPath = image?.approveFromPath
  const toPath = image?.approveToPath
  if (fromPath === undefined || toPath === undefined) return null
  if (!isAbsolute(fromPath) || !isAbsolute(toPath) || !existsSync(fromPath)) return null
  return { fromPath, toPath }
}

type ApprovalPlan =
  | { kind: 'metadata'; fromPath: string; toPath: string }
  | { kind: 'resolver'; actualUrl: string; snapshotPath: string }
  | { kind: 'no-actual' }
  | { kind: 'unresolved' }

/**
 * Metadata first (D3): a validated reporter-declared baseline wins; otherwise
 * fall back to the Playwright snapshot resolver; images with neither are
 * unresolved and get skipped by approve-all.
 */
function planApproval(ctx: RoutesContext, test: TestData, retry: number, imageName: string): ApprovalPlan {
  const image = test.results?.[retry]?.images?.[imageName]
  const metadata = approvalMetadataFromImage(image)
  if (metadata !== null) {
    return { kind: 'metadata', fromPath: metadata.fromPath, toPath: metadata.toPath }
  }

  const actualUrl = image?.actual
  if (actualUrl === undefined) {
    return { kind: 'no-actual' }
  }

  const snapshotPath = resolveBaselineSnapshotPath(ctx.approvalRouting, test, retry, imageName)
  if (snapshotPath === null) {
    return { kind: 'unresolved' }
  }

  return { kind: 'resolver', actualUrl, snapshotPath }
}

/** Approving a first-run baseline is a same-file no-op; copying a file onto
 * itself is platform-fragile, so identical paths skip the copy entirely. */
async function copyApprovalSource(sourcePath: string, targetPath: string): Promise<void> {
  if (sourcePath === targetPath) return
  await copyFilePortable(sourcePath, targetPath)
}

function actualPathFromUrl(ctx: RoutesContext, actualUrl: string): string {
  if (actualUrl.startsWith('/screenshots/')) {
    return join(ctx.reportData.screenshotDir, actualUrl.slice('/screenshots/'.length))
  }
  if (actualUrl.startsWith('/file/')) {
    return decodeURIComponent(actualUrl.slice('/file/'.length))
  }
  return actualUrl
}

export async function handleApiApprove(ctx: RoutesContext, req: Request): Promise<Response> {
  try {
    const rawBody: unknown = await req.json()
    const parsed = safeParse(ApproveRequestBodySchema, rawBody)
    if (!parsed) {
      console.error('Invalid approve request body', rawBody)
      return Response.json({ success: false, error: 'Invalid request body' }, { status: 400 })
    }
    const { id, retry, image } = parsed

    const test = ctx.reportData.tests[id]
    if (test === undefined) {
      return Response.json({ success: false, error: 'Test not found' }, { status: 404 })
    }

    const plan = planApproval(ctx, test, retry, image)
    if (plan.kind === 'no-actual') {
      return Response.json({ success: false, error: 'Actual image not found' }, { status: 409 })
    }
    if (plan.kind === 'unresolved') {
      return Response.json({ success: false, error: APPROVAL_TARGET_ERROR }, { status: 409 })
    }

    const sourcePath = plan.kind === 'metadata' ? plan.fromPath : actualPathFromUrl(ctx, plan.actualUrl)
    const targetPath = plan.kind === 'metadata' ? plan.toPath : plan.snapshotPath

    try {
      await copyApprovalSource(sourcePath, targetPath)
      test.approved = { ...(test.approved ?? {}), [image]: retry }
      await ctx.saveReport()
      console.log(`  ✔ Updated baseline: ${targetPath}`)
      console.log(`  ✔ Approved [${test.browser}] ${test.title} — ${image}`)
      return Response.json({ success: true })
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      console.error(`  ✗ Failed to update baseline: ${errorMsg}`)
      return Response.json({ success: false, error: 'Failed to update baseline' }, { status: 500 })
    }
  } catch {
    return Response.json({ success: false, error: 'Invalid request' }, { status: 400 })
  }
}

type BulkApprovalOutcome =
  | {
      kind: 'approved'
      imageName: string
      retry: number
      snapshotPath: string
      test: TestData
    }
  | { kind: 'unresolved' }
  | { kind: 'failed' }

type BulkApprovalCounts = { approved: number; unresolved: number; failed: number }

function createBulkApprovalUpdates(ctx: RoutesContext): Array<Promise<BulkApprovalOutcome>> {
  return Object.values(ctx.reportData.tests).flatMap((test) => {
    if (!test.results || test.results.length === 0) {
      return []
    }

    const lastRetry = test.results.length - 1
    const lastResult = test.results[lastRetry]
    if (!lastResult?.images) {
      return []
    }

    return Object.keys(lastResult.images).flatMap((imageName) => {
      const plan = planApproval(ctx, test, lastRetry, imageName)
      if (plan.kind === 'no-actual' || plan.kind === 'unresolved') {
        return [Promise.resolve({ kind: 'unresolved' as const })]
      }

      const sourcePath = plan.kind === 'metadata' ? plan.fromPath : actualPathFromUrl(ctx, plan.actualUrl)
      const targetPath = plan.kind === 'metadata' ? plan.toPath : plan.snapshotPath

      return [
        copyApprovalSource(sourcePath, targetPath)
          .then(
            (): BulkApprovalOutcome => ({
              kind: 'approved',
              imageName,
              retry: lastRetry,
              snapshotPath: targetPath,
              test,
            }),
          )
          .catch((err: unknown): BulkApprovalOutcome => {
            const errorMsg = err instanceof Error ? err.message : String(err)
            console.error(`  ✗ Failed to update baseline: ${errorMsg}`)
            return { kind: 'failed' }
          }),
      ]
    })
  })
}

function summarizeBulkApprovalOutcomes(outcomes: readonly BulkApprovalOutcome[]): BulkApprovalCounts {
  return outcomes.reduce(
    (summary, outcome) => {
      switch (outcome.kind) {
        case 'approved': {
          outcome.test.approved = { ...(outcome.test.approved ?? {}), [outcome.imageName]: outcome.retry }
          console.log(`  ✔ Updated baseline: ${outcome.snapshotPath}`)
          return { ...summary, approved: summary.approved + 1 }
        }
        case 'unresolved':
          return { ...summary, unresolved: summary.unresolved + 1 }
        case 'failed':
          return { ...summary, failed: summary.failed + 1 }
      }
    },
    { approved: 0, unresolved: 0, failed: 0 },
  )
}

export async function handleApiApproveAll(ctx: RoutesContext): Promise<Response> {
  const outcomes = await Promise.all(createBulkApprovalUpdates(ctx))
  const counts = summarizeBulkApprovalOutcomes(outcomes)
  await ctx.saveReport()
  console.log(
    `  ✔ Approved all — approved: ${counts.approved}, unresolved: ${counts.unresolved}, failed: ${counts.failed}`,
  )
  return Response.json({ success: counts.failed === 0, ...counts })
}
