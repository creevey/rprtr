import { z } from 'zod'

// Approve request body schema
export const ApproveRequestBodySchema = z.object({
  id: z.string(),
  retry: z.number(),
  image: z.string(),
})

export type ApproveRequestBody = z.infer<typeof ApproveRequestBodySchema>

export const RunRequestBodySchema = z.object({
  files: z.array(z.string()).optional(),
  project: z.string().optional(),
})

export type RunRequestBody = z.infer<typeof RunRequestBodySchema>

export const RunResponseSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true) }),
  z.object({
    ok: z.literal(false),
    reason: z.enum(['no-config', 'already-running']),
  }),
])

export type RunResponse = z.infer<typeof RunResponseSchema>

export const StopResponseSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true) }),
  z.object({
    ok: z.literal(false),
    reason: z.literal('not-running'),
  }),
])

export type StopResponse = z.infer<typeof StopResponseSchema>
