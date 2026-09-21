import { createRequire } from 'module'

import { z } from 'zod'

import type { PinBrowser } from './browser-pins.ts'
import { missingPeerError } from './peer-guard.ts'

/** The slice of Playwright's `BrowserType` the reporter actually uses. */
export interface BrowserTypeLike {
  executablePath(): string
}

const browserTypeSchema = z.custom<BrowserTypeLike>(
  (value) =>
    typeof value === 'object' &&
    value !== null &&
    'executablePath' in value &&
    typeof value.executablePath === 'function',
  { message: 'not a Playwright browser type' },
)

/** `@playwright/test`'s CJS export is callable, so the module cannot be parsed
 * as a plain object — each browser type is validated on its own instead. */
interface PlaywrightModule {
  chromium?: unknown
  firefox?: unknown
  webkit?: unknown
}

const playwrightModuleSchema = z.custom<PlaywrightModule>(
  (value) => value !== null && (typeof value === 'object' || typeof value === 'function'),
  { message: '@playwright/test did not export a module' },
)

/**
 * Loads Playwright's browser types on demand, so `@crvy/rprtr` can be imported
 * in a project that does not have the optional `@playwright/test` peer at all.
 * A module-scope import would resolve — and fail — before any guard could run.
 */
function loadPlaywrightBrowserTypes(): Record<PinBrowser, BrowserTypeLike> {
  // Annotated so the module arrives as `unknown` rather than `any`.
  const requirePeer: (specifier: string) => unknown = createRequire(import.meta.url)
  let loaded: unknown
  try {
    loaded = requirePeer('@playwright/test')
  } catch (error) {
    throw missingPeerError('@playwright/test', '@crvy/rprtr', error)
  }
  const playwright = playwrightModuleSchema.parse(loaded)
  return {
    chromium: browserTypeSchema.parse(playwright.chromium),
    firefox: browserTypeSchema.parse(playwright.firefox),
    webkit: browserTypeSchema.parse(playwright.webkit),
  }
}

/** Injected browser types win; Playwright is only loaded for the ones missing. */
export function resolveBrowserTypes(
  injected: Partial<Record<PinBrowser, BrowserTypeLike>> = {},
): Record<PinBrowser, BrowserTypeLike> {
  const { chromium, firefox, webkit } = injected
  if (chromium !== undefined && firefox !== undefined && webkit !== undefined) return { chromium, firefox, webkit }

  const playwright = loadPlaywrightBrowserTypes()
  return {
    chromium: chromium ?? playwright.chromium,
    firefox: firefox ?? playwright.firefox,
    webkit: webkit ?? playwright.webkit,
  }
}
