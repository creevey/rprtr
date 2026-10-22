import { PIN_BROWSERS, type PinBrowser } from './schemas/pins.ts'

/**
 * Browser revisions observable in a container image, keyed by Playwright
 * browser. A list because an image may carry more than one build; pin
 * resolution only needs to know whether the manifest's revision is present.
 */
export type ImageBrowserRevisions = Partial<Record<PinBrowser, readonly string[]>>

const BROWSER_DIRECTORY = /^(chromium|firefox|webkit)-(\d+)$/
const REVISION = /^\d+$/
const PIN_BROWSER_SET: ReadonlySet<string> = new Set(PIN_BROWSERS)

function isPinBrowser(value: string): value is PinBrowser {
  return PIN_BROWSER_SET.has(value)
}

/** Parses `ls` output from a Playwright browser cache directory. */
export function parseImageBrowserRevisions(output: string): ImageBrowserRevisions {
  const revisions: Partial<Record<PinBrowser, string[]>> = {}
  for (const line of output.split(/\r?\n/)) {
    const match = BROWSER_DIRECTORY.exec(line.trim())
    if (match === null) continue
    const browser = match[1]!
    if (!isPinBrowser(browser)) continue
    const revision = match[2]!
    const list = revisions[browser] ?? []
    if (!list.includes(revision)) list.push(revision)
    revisions[browser] = list
  }
  return revisions
}

/**
 * Parses the `CRVY_RPRTR_DOCKER_BROWSER_REVISIONS` payload the server exports
 * for a sidecar-backed run. Malformed data is ignored: pin resolution falls
 * back to unverifiable rather than trusting a partial probe.
 */
export function parseImageBrowserRevisionsEnv(value: string | undefined): ImageBrowserRevisions | undefined {
  if (value === undefined || value.trim() === '') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined

  const revisions: Partial<Record<PinBrowser, string[]>> = {}
  for (const [browser, entry] of Object.entries(parsed)) {
    if (!isPinBrowser(browser)) return undefined
    if (!Array.isArray(entry) || entry.length === 0) return undefined
    const browserRevisions: string[] = []
    for (const revision of entry) {
      if (typeof revision !== 'string' || !REVISION.test(revision)) return undefined
      browserRevisions.push(revision)
    }
    revisions[browser] = browserRevisions
  }
  return Object.keys(revisions).length === 0 ? undefined : revisions
}
