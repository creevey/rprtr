import { parseImageBrowserRevisions, type ImageBrowserRevisions } from '../image-browsers.ts'
import type { DockerExec } from './docker-support.ts'

/**
 * Prints the browser builds bundled into an image without launching a browser
 * or touching the network. Covers the official image's fixed cache and the
 * per-user cache a custom `node` image gets from `playwright install`.
 */
const PROBE_SCRIPT = [
  'for dir in "${PLAYWRIGHT_BROWSERS_PATH:-}" /ms-playwright "${HOME:-/root}/.cache/ms-playwright" /root/.cache/ms-playwright /home/*/.cache/ms-playwright; do',
  '  if [ -d "$dir" ]; then',
  '    ls -1 "$dir"',
  '    exit 0',
  '  fi',
  'done',
  'exit 1',
].join('\n')

export interface ProbeImageBrowsersInput {
  exec: DockerExec
  image: string
}

/**
 * Resolves the browser revisions present in an image by listing its Playwright
 * cache. Null when the image cannot be inspected — an unreadable probe must
 * leave pins unverifiable, never guess.
 */
export interface ImageBrowserProbe {
  (image: string | undefined): Promise<ImageBrowserRevisions | null>
  reset(): void
}

/** Caches one image's probe result; a restarted or replaced image is probed again. */
export function createImageBrowserProbe(exec: DockerExec): ImageBrowserProbe {
  let probedImage: string | undefined
  let revisions: ImageBrowserRevisions | null = null
  return Object.assign(
    async (image: string | undefined): Promise<ImageBrowserRevisions | null> => {
      if (image === undefined) return null
      if (probedImage !== image) {
        revisions = await probeImageBrowsers({ exec, image })
        probedImage = image
      }
      return revisions
    },
    {
      reset: (): void => {
        probedImage = undefined
        revisions = null
      },
    },
  )
}

export async function probeImageBrowsers(input: ProbeImageBrowsersInput): Promise<ImageBrowserRevisions | null> {
  let result: Awaited<ReturnType<DockerExec>>
  try {
    result = await input.exec([
      'run',
      '--rm',
      '--network',
      'none',
      '--entrypoint',
      'sh',
      input.image,
      '-c',
      PROBE_SCRIPT,
    ])
  } catch {
    return null
  }
  if (result.exitCode !== 0) return null

  const revisions = parseImageBrowserRevisions(result.stdout)
  return Object.keys(revisions).length === 0 ? null : revisions
}
