import { readFileSync } from 'fs'
import { basename, extname, join, relative } from 'path'

import { log } from './debug-log.ts'
import { buildReferencePath } from './vitest-helpers.ts'
import { maskLiteralsAndComments } from './vitest-source-mask.ts'
import {
  extractScreenshotCallSites,
  scanTestBlocks,
  type ScannedBlock,
  type ScannedScreenshotArgument,
} from './vitest-source-scan.ts'

export type ScreenshotDeclaration =
  | {
      readonly kind: 'named'
      readonly visualName: string
      readonly declaredName: string
      readonly snapshotBaseName: string
      readonly occurrenceIndex: number
    }
  | {
      readonly kind: 'unnamed'
      readonly visualName: string
      readonly occurrenceIndex: number
    }

export interface ExtractedVitestScreenshot {
  readonly declaration: ScreenshotDeclaration
  readonly imageName: string
  readonly referencePath: string
}

export interface VitestDeclarationContext {
  readonly projectRoot: string
  readonly referenceDir: string
  readonly testFile: string
  readonly browser: string
}

const VITEST_FULL_NAME_SEPARATOR = ' > '
const SUPPORTED_EXTENSIONS = ['png']

function suiteChain(blocks: readonly ScannedBlock[], target: ScannedBlock): readonly string[] | null {
  const enclosingSuites = blocks
    .filter((block) => block.kind === 'suite' && block.start < target.start && target.start < block.spanEnd)
    .sort((first, second) => first.start - second.start)
  const titles: string[] = []
  for (const suite of enclosingSuites) {
    if (suite.title === null) return null
    titles.push(suite.title)
  }
  return titles
}

/**
 * Best-effort title attribution: the test's suite chain (Vitest's full name is
 * the suite titles plus the test name joined by ' > ') must match the
 * reporter's title path exactly. The first matching block wins.
 */
function attributeTestBlock(
  blocks: readonly ScannedBlock[],
  titlePath: readonly string[],
  testName: string,
): ScannedBlock | null {
  for (const block of blocks) {
    if (block.kind !== 'test' || block.title !== testName) continue
    const chain = suiteChain(blocks, block)
    if (chain === null) continue
    if (chain.length !== titlePath.length) continue
    if (chain.every((title, index) => title === titlePath[index])) return block
  }
  return null
}

/**
 * Mirror of @vitest/browser's `sanitize`: per-segment sanitization (whitespace
 * → '-', strip non-[\w-], collapse repeats) over a root-relative path. pathe
 * normalizes backslashes, so they are folded to '/' first.
 */
function sanitizeScreenshotName(name: string): string {
  const normalized = name.replaceAll('\\', '/')
  const rootRelative = relative('/', join('/', normalized))
  return rootRelative
    .split('/')
    .map((segment) =>
      segment
        .replace(/\s+/g, '-')
        .replace(/[^\w-]+/g, '')
        .replace(/-{2,}/g, '-'),
    )
    .join('/')
}

/**
 * Mirror of @vitest/browser's `resolveOptions` extension handling: a supported
 * extension is stripped with basename semantics; anything else is kept
 * verbatim (Vitest renders the final artifact as `.png`).
 */
function stripSupportedExtension(name: string): string {
  const extensionFromName = extname(name)
  const extension = extensionFromName.replace(/^\./, '')
  if (!SUPPORTED_EXTENSIONS.includes(extension)) return name
  return extensionFromName.endsWith(extension) ? basename(name, extensionFromName) : name
}

function toDeclaration(argument: ScannedScreenshotArgument, fullName: string, counter: number): ScreenshotDeclaration {
  if (argument.kind === 'named') {
    const visualName = sanitizeScreenshotName(stripSupportedExtension(argument.raw))
    return {
      kind: 'named',
      visualName,
      declaredName: argument.raw,
      snapshotBaseName: visualName,
      occurrenceIndex: counter,
    }
  }
  // Vitest names unnamed assertions `${currentTestName} ${counter}` before
  // sanitizing — the counter is shared by every matcher call in the test.
  const visualName = sanitizeScreenshotName(`${fullName} ${counter}`)
  return { kind: 'unnamed', visualName, occurrenceIndex: counter }
}

/**
 * Extracts each `toMatchScreenshot` declaration of one test from the test
 * module's source. Vitest records no artifacts for passing screenshot
 * assertions, so the source is the only remaining source of truth; the
 * extraction mirrors Vitest's own naming (sanitization, occurrence counter,
 * reference layout via `buildReferencePath`) so the derived paths match the
 * files Vitest writes and reads on disk. Non-literal arguments and
 * unattributable tests degrade to no declaration.
 */
export function extractVitestScreenshots(
  source: string,
  titlePath: readonly string[],
  testName: string,
  context: VitestDeclarationContext,
): ExtractedVitestScreenshot[] {
  if (!source.includes('toMatchScreenshot')) return []
  const masked = maskLiteralsAndComments(source)
  const blocks = scanTestBlocks(source, masked)
  const testBlock = attributeTestBlock(blocks, titlePath, testName)
  if (testBlock === null) return []

  const fullName = [...titlePath, testName].join(VITEST_FULL_NAME_SEPARATOR)
  const byImageName = new Map<string, ExtractedVitestScreenshot>()
  for (const call of extractScreenshotCallSites(source, masked, testBlock.bodyStart, testBlock.bodyEnd)) {
    if (call.argument.kind === 'dynamic') continue
    const declaration = toDeclaration(call.argument, fullName, call.counter)
    // Vitest reads and writes one reference file per sanitized name — repeated
    // identical names share it, so later occurrences add nothing.
    if (byImageName.has(declaration.visualName)) continue
    byImageName.set(declaration.visualName, {
      declaration,
      imageName: declaration.visualName,
      referencePath: buildReferencePath(
        context.projectRoot,
        context.referenceDir,
        context.testFile,
        declaration.visualName,
        context.browser,
      ),
    })
  }
  return [...byImageName.values()]
}

/**
 * Reads the test module's source for extraction. An unreadable module
 * (deleted between run and report, unreadable permissions) degrades to null —
 * the caller keeps failure-only behavior.
 */
export function loadTestSource(moduleId: string): string | null {
  try {
    return readFileSync(moduleId, 'utf-8')
  } catch (error: unknown) {
    log('[CrvyRprtrVitestReporter] Failed to read test module source:', moduleId, error)
    return null
  }
}

export function extractVitestScreenshotsFromModule(
  moduleId: string,
  titlePath: readonly string[],
  testName: string,
  context: VitestDeclarationContext,
): ExtractedVitestScreenshot[] {
  const source = loadTestSource(moduleId)
  if (source === null) return []
  return extractVitestScreenshots(source, titlePath, testName, context)
}
