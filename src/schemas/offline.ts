import { z } from 'zod'

// Offline event schema
export const OfflineEventSchema = z.object({
  type: z.enum(['test-begin', 'test-end', 'run-end']),
  data: z.unknown(),
  timestamp: z.number(),
  workerIndex: z.number(),
})

export type OfflineEvent = z.infer<typeof OfflineEventSchema>

// Offline report schema
export const OfflineReportSchema = z.object({
  version: z.number(),
  generatedAt: z.string(),
  workers: z.number(),
  events: z.array(OfflineEventSchema),
})

export type OfflineReport = z.infer<typeof OfflineReportSchema>
