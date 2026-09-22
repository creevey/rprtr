import { existsSync } from 'fs'

import type { TestCase } from 'vitest/node'

import { log } from './debug-log.ts'
import type { ScreenshotDeclaration } from './reporter-utils.ts'
import type { VisualArtifactEntry } from './vitest-artifacts.ts'
import { extractVitestScreenshots, type VitestDeclarationContext } from './vitest-declarations.ts'
import { getTitlePath } from './vitest-helpers.ts'

export interface PassingVisualData {
  readonly entries: VisualArtifactEntry[]
  readonly declarations: ScreenshotDeclaration[]
}

export const NO_PASSING_VISUAL_DATA: PassingVisualData = { entries: [], declarations: [] }

export interface PassingVisualInput {
  readonly projectRoot: string
  readonly referenceDir: string
  readonly testCase: TestCase
  readonly browser: string
  /** Reads a test module's source; null when unavailable. */
  readonly moduleSource: (moduleId: string) => string | null
}

/**
 * Declarations for a passing visual test, derived from its module source.
 * Only references that exist on disk are surfaced — a missing reference is
 * logged and omitted (Vitest's own first-run behavior reports it honestly).
 */
export function passingVisualData(input: PassingVisualInput): PassingVisualData {
  const source = input.moduleSource(input.testCase.module.moduleId)
  if (source === null) return NO_PASSING_VISUAL_DATA

  const context: VitestDeclarationContext = {
    projectRoot: input.projectRoot,
    referenceDir: input.referenceDir,
    testFile: input.testCase.module.moduleId,
    browser: input.browser,
  }
  const entries: VisualArtifactEntry[] = []
  const declarations: ScreenshotDeclaration[] = []
  for (const { declaration, imageName, referencePath } of extractVitestScreenshots(
    source,
    getTitlePath(input.testCase),
    input.testCase.name,
    context,
  )) {
    if (!existsSync(referencePath)) {
      log(
        `[CrvyRprtrVitestReporter] Missing reference for passing screenshot "${imageName}"; ` +
          'the image is not synthesized: ' +
          referencePath,
      )
      continue
    }
    entries.push({ imageName, paths: { expected: referencePath } })
    declarations.push(declaration)
  }
  return { entries, declarations }
}
