import type { FontRendering } from './rendering.ts'
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
}
