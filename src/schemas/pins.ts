import { z } from 'zod'

// Browser pin declaration and effective-environment schemas. Kept in this
// node-free module so the client bundle can import them through schemas.ts
// while browser-pins.ts handles resolution and filesystem reads.
export const PIN_BROWSERS = ['chromium', 'firefox', 'webkit'] as const

export type PinBrowser = (typeof PIN_BROWSERS)[number]

/** One or more dot-separated numeric segments: `147`, `147.0`, `147.0.7727.15`. */
export function isVersionPrefix(value: string): boolean {
  return /^\d+(?:\.\d+)*$/.test(value)
}

export const VersionPrefixSchema = z.string().refine(isVersionPrefix, {
  message: 'must be one or more dot-separated numeric version segments (e.g. "147" or "147.0.7727.15")',
})

export const BrowserPinSchema = z.object({
  browser: z.enum(PIN_BROWSERS),
  version: VersionPrefixSchema,
})

export type BrowserPin = z.infer<typeof BrowserPinSchema>

/**
 * `pinned`/`drift` require an observable build; `unknown` is reserved for
 * legacy artifacts without environment data.
 */
export const BrowserPinStatusSchema = z.enum(['pinned', 'drift', 'unpinned', 'unverifiable', 'unknown'])

export type BrowserPinStatus = z.infer<typeof BrowserPinStatusSchema>

export const ProjectEnvironmentSchema = z.object({
  playwrightVersion: z.string().nullable(),
  browser: z.enum(PIN_BROWSERS),
  browserVersion: z.string().nullable(),
  revision: z.string().nullable(),
  dockerImage: z.string().optional(),
  pin: BrowserPinSchema.optional(),
  status: BrowserPinStatusSchema,
})

export type ProjectEnvironment = z.infer<typeof ProjectEnvironmentSchema>

export const RunEnvironmentsSchema = z.record(z.string(), ProjectEnvironmentSchema)

export type RunEnvironments = z.infer<typeof RunEnvironmentsSchema>
