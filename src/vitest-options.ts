import type { BrowserPinPolicy } from './browser-pins.ts'
import type { FontRendering } from './rendering.ts'
import type { BrowserPin } from './schemas/pins.ts'
import type { ReporterTransportOptions } from './transport.ts'

export interface CrvyRprtrVitestReporterOptions extends ReporterTransportOptions {
  /**
   * Text antialiasing for the browsers this run launches. `grayscale` (default)
   * pins it so baselines compare across environments; `inherit` leaves the
   * environment's own rendering alone.
   */
  fontRendering?: FontRendering
  /** Overrides vitest's default reference directory (`__screenshots__`). */
  referenceDir?: string
  /** Overrides vitest's default attachments directory (`.vitest-attachments`). */
  attachmentsDir?: string
  /**
   * Fallback browser pin for every browser project the reporter reports on that
   * has no keyed pin; `warn` (default) reports drift without failing, `fail`
   * fails reporter initialization.
   */
  browserPin?: BrowserPin
  /** Browser pins keyed by Vitest project name (browser instance); overrides `browserPin`. */
  browserPins?: Record<string, BrowserPin>
  /** `warn` (default) reports drifted pins without failing tests; `fail` fails at reporter init. */
  browserPinPolicy?: BrowserPinPolicy
}
