import { z } from 'zod'

import { safeParse } from './schemas'

export interface ApprovalResult {
  readonly success: boolean
}

export interface BulkApprovalResult {
  readonly success: boolean
  readonly approved: number
  readonly unresolved: number
  readonly failed: number
}

const ApprovalResponseBodySchema = z.object({
  success: z.boolean(),
  error: z.string().optional(),
})

const BulkApprovalResponseBodySchema = z.object({
  success: z.boolean(),
  approved: z.number(),
  unresolved: z.number(),
  failed: z.number(),
})

const failedApprovalResult: ApprovalResult = { success: false }
const failedBulkApprovalResult: BulkApprovalResult = {
  success: false,
  approved: 0,
  unresolved: 0,
  failed: 0,
}

async function readJsonBody(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return null
  }
}

export async function readApproveResult(response: Response): Promise<ApprovalResult> {
  const body = safeParse(ApprovalResponseBodySchema, await readJsonBody(response))
  return body !== null && response.ok && body.success ? body : failedApprovalResult
}

export async function readApproveAllResult(response: Response): Promise<BulkApprovalResult> {
  const body = safeParse(BulkApprovalResponseBodySchema, await readJsonBody(response))
  if (body === null) {
    return failedBulkApprovalResult
  }

  return {
    success: response.ok && body.success,
    approved: body.approved,
    unresolved: body.unresolved,
    failed: body.failed,
  }
}

/** @public — used by Svelte components (knip does not trace .svelte imports) */
export function isBulkApprovalOptimisticSafe(result: BulkApprovalResult): boolean {
  return result.success && result.unresolved === 0 && result.failed === 0
}
