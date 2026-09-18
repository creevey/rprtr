import { z } from 'zod'

/**
 * Reporter options come from a consumer's config file, so the value is external
 * input: a typo has to fail at reporter init rather than silently leaving the
 * run with the environment's own antialiasing, which is the failure mode this
 * option exists to remove.
 */
export const FontRenderingSchema = z.enum(['grayscale', 'inherit'])

export const FontRenderingOptionSchema = z.object({
  fontRendering: FontRenderingSchema.default('grayscale'),
})

/** Validates and defaults the `fontRendering` reporter option. Throws on anything else. */
export function parseFontRendering(options: { fontRendering?: unknown }): z.infer<typeof FontRenderingSchema> {
  const parsed = FontRenderingOptionSchema.safeParse({ fontRendering: options.fontRendering })
  if (parsed.success) return parsed.data.fontRendering
  throw new Error(
    `Invalid crvy-rprtr option fontRendering: expected 'grayscale' or 'inherit', received ${JSON.stringify(options.fontRendering)}`,
  )
}
