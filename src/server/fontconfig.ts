import { mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { GRAYSCALE_FONTCONFIG_XML } from '../fontconfig.ts'

export { GRAYSCALE_FONTCONFIG_XML }

/**
 * Mount point inside the container. `99-` keeps it last in `conf.d`, after the distro's own
 * subpixel and hinting drop-ins.
 *
 * Docker run mode pins AA one level below the browser because a reporter cannot pass browser
 * args — the same reason local mode goes through `FONTCONFIG_FILE` (`src/fontconfig.ts`).
 * Inside a container the drop-in is the simpler half: the image's own `conf.d` is right there
 * to write into, so nothing has to be re-included.
 */
export const CONTAINER_FONTCONFIG_PATH = '/etc/fonts/conf.d/99-crvy-rprtr-grayscale.conf'

/** Stable host path, so repeated runs reuse one file instead of littering the temp dir. */
export function hostFontconfigPath(): string {
  return join(tmpdir(), 'crvy-rprtr', '99-crvy-rprtr-grayscale.conf')
}

/**
 * Writes the drop-in and returns its host path. Synchronous and called while the `docker run`
 * arg vector is built: docker silently creates a **directory** in place of a missing bind
 * source, which would mount garbage into `conf.d`, so the file must exist by the time the
 * mount is added — not merely by the time `prepare()` finishes.
 */
export function ensureGrayscaleFontconfig(): string {
  const path = hostFontconfigPath()
  mkdirSync(join(tmpdir(), 'crvy-rprtr'), { recursive: true })
  writeFileSync(path, GRAYSCALE_FONTCONFIG_XML, 'utf8')
  return path
}
