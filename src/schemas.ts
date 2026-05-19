import { z } from 'zod'

// Location schema
export const LocationSchema = z.object({
  file: z.string(),
  line: z.number(),
})

export type Location = z.infer<typeof LocationSchema>

export const VisualSourceSchema = z.enum(['comparison', 'baseline-only', 'declared-only'])

export type VisualSource = z.infer<typeof VisualSourceSchema>

// Images schema
export const ImagesSchema = z.object({
  actual: z.string().optional(),
  expect: z.string().optional(),
  diff: z.string().optional(),
  error: z.string().optional(),
  source: VisualSourceSchema.optional(),
})

export type Images = z.infer<typeof ImagesSchema>

export const ScreenshotDeclarationSchema = z.discriminatedUnion('kind', [
  z.object({
    visualName: z.string(),
    kind: z.literal('named'),
    declaredName: z.string(),
    snapshotBaseName: z.string(),
    occurrenceIndex: z.number(),
  }),
  z.object({
    visualName: z.string(),
    kind: z.literal('unnamed'),
    occurrenceIndex: z.number(),
  }),
])

export type ScreenshotDeclaration = z.infer<typeof ScreenshotDeclarationSchema>

// Attachment schema
export const AttachmentSchema = z.object({
  name: z.string(),
  path: z.string(),
  contentType: z.string(),
})

export type Attachment = z.infer<typeof AttachmentSchema>

// Test status enum
export const TestStatusSchema = z.enum(['unknown', 'pending', 'running', 'failed', 'approved', 'success', 'retrying'])

export type TestStatus = z.infer<typeof TestStatusSchema>

export const TestResultStatusSchema = z.enum(['failed', 'success', 'pending'])

export type TestResultStatus = z.infer<typeof TestResultStatusSchema>

// Test result schema
export const TestResultSchema = z.object({
  status: TestResultStatusSchema,
  retries: z.number(),
  images: z.record(z.string(), ImagesSchema).optional(),
  visualDeclarations: z.array(ScreenshotDeclarationSchema).optional(),
  error: z.string().optional(),
  duration: z.number().optional(),
})

export type TestResult = z.infer<typeof TestResultSchema>

// Test data schema
export const TestDataSchema = z.object({
  id: z.string(),
  titlePath: z.array(z.string()),
  browser: z.string(),
  title: z.string(),
  skip: z.union([z.boolean(), z.string()]).optional(),
  retries: z.number().optional(),
  status: TestStatusSchema.optional(),
  results: z.array(TestResultSchema).optional(),
  approved: z.record(z.string(), z.number()).nullable().optional(),
  attachments: z.array(AttachmentSchema).optional(),
  location: LocationSchema.optional(),
})

export type TestData = z.infer<typeof TestDataSchema>

// Crvy Rprtr test schema (extends TestData)
export const CrvyRprtrTestSchema = TestDataSchema.extend({
  checked: z.boolean(),
})

export type CrvyRprtrTest = z.infer<typeof CrvyRprtrTestSchema>

// Crvy Rprtr suite type (recursive)
export interface CrvyRprtrSuite {
  path: string[]
  skip: boolean
  status?: TestStatus
  opened: boolean
  checked: boolean
  indeterminate: boolean
  children?: Partial<Record<string, CrvyRprtrSuite | CrvyRprtrTest>>
}

// Crvy Rprtr suite schema (recursive) - explicitly typed to maintain type safety
export const CrvyRprtrSuiteSchema: z.ZodType<CrvyRprtrSuite> = z.lazy(() =>
  z.object({
    path: z.array(z.string()),
    skip: z.boolean(),
    status: TestStatusSchema.optional(),
    opened: z.boolean(),
    checked: z.boolean(),
    indeterminate: z.boolean(),
    children: z.record(z.string(), z.union([CrvyRprtrSuiteSchema, CrvyRprtrTestSchema])).optional(),
  }),
)

// WebSocket message types
export const WebSocketMessageSchema = z.object({
  type: z.enum(['test-begin', 'test-end', 'run-end', 'approve', 'sync']),
  data: z.unknown(),
})

export type WebSocketMessage = z.infer<typeof WebSocketMessageSchema>

// Test begin data schema
export const TestBeginDataSchema = z.object({
  id: z.string(),
  title: z.string(),
  titlePath: z.array(z.string()),
  browser: z.string(),
  location: LocationSchema,
})

export type TestBeginData = z.infer<typeof TestBeginDataSchema>

// Test end data schema
export const TestEndDataSchema = z.object({
  id: z.string(),
  status: z.enum(['passed', 'failed', 'skipped']),
  attachments: z.array(AttachmentSchema),
  visualNames: z.array(z.string()).default([]),
  visualDeclarations: z.array(ScreenshotDeclarationSchema).optional(),
  error: z.string().optional(),
  duration: z.number().optional(),
})

export type TestEndData = z.infer<typeof TestEndDataSchema>

// Report data schema
export const ReportDataSchema = z.object({
  isRunning: z.boolean(),
  tests: z.record(z.string(), TestDataSchema),
  browsers: z.array(z.string()),
  isUpdateMode: z.boolean(),
  screenshotDir: z.string(),
})

export type ReportData = z.infer<typeof ReportDataSchema>

// Loaded report data schema (partial)
export const LoadedReportDataSchema = z.object({
  tests: z.record(z.string(), TestDataSchema).optional(),
  isUpdateMode: z.boolean().optional(),
})

export type LoadedReportData = z.infer<typeof LoadedReportDataSchema>

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

// Approve request body schema
export const ApproveRequestBodySchema = z.object({
  id: z.string(),
  retry: z.number(),
  image: z.string(),
})

export type ApproveRequestBody = z.infer<typeof ApproveRequestBodySchema>

// Report API response schema
export const ReportApiResponseSchema = z.object({
  tests: z.record(z.string(), TestDataSchema),
  isUpdateMode: z.boolean().optional(),
})

export type ReportApiResponse = z.infer<typeof ReportApiResponseSchema>

export const ClientBootstrapDataSchema = z.object({
  report: ReportApiResponseSchema.extend({
    isUpdateMode: z.boolean(),
  }),
  liveUpdates: z.boolean(),
  approvalEnabled: z.boolean(),
  approvalMessage: z.string().optional(),
})

export type ClientBootstrapData = z.infer<typeof ClientBootstrapDataSchema>

// View modes
export const ImagesViewModeSchema = z.enum(['side-by-side', 'swap', 'slide', 'blend'])

export type ImagesViewMode = z.infer<typeof ImagesViewModeSchema>

// Helper function to safely parse with zod
export function safeParse<T>(schema: z.ZodType<T>, data: unknown): T | null {
  const result = schema.safeParse(data)
  if (result.success) {
    return result.data
  }
  return null
}

// Helper function to parse or throw
export function parseOrThrow<T>(schema: z.ZodType<T>, data: unknown, errorMessage: string): T {
  const result = schema.safeParse(data)
  if (result.success) {
    return result.data
  }
  throw new Error(`${errorMessage}: ${result.error.message}`)
}
