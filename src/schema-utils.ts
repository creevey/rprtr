import type { z } from 'zod'

/** Helper function to safely parse with zod */
export function safeParse<T>(schema: z.ZodType<T>, data: unknown): T | null {
  const result = schema.safeParse(data)
  if (result.success) {
    return result.data
  }
  return null
}

/** Helper function to parse or throw */
export function parseOrThrow<T>(schema: z.ZodType<T>, data: unknown, errorMessage: string): T {
  const result = schema.safeParse(data)
  if (result.success) {
    return result.data
  }
  throw new Error(`${errorMessage}: ${result.error.message}`)
}
