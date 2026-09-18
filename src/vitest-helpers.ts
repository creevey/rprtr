import { basename, dirname, join, relative } from 'path'

import type { ResolvedConfig, TestCase, Vitest } from 'vitest/node'

export type VitestStatus = 'passed' | 'failed' | 'skipped'

export interface ParsedVitestImagePaths {
  imageName: string
  actualPath?: string
  diffPath?: string
  referencePath?: string
}

type VitestTaskState = ReturnType<TestCase['result']>['state']

const ANSI_ESCAPE = new RegExp(String.raw`\u001B\[[0-?]*[ -/]*[@-~]`, 'g')

export function getTitlePath(testCase: TestCase): string[] {
  const titlePath: string[] = []
  let parent: TestCase['parent'] | undefined = testCase.parent
  while (parent !== undefined && parent.type !== 'module') {
    titlePath.unshift(parent.name)
    parent = parent.parent
  }
  return titlePath
}

/**
 * Project name → sidebar browser label. Empty project names fall back to the
 * project's configured browser instance, then to a generic label.
 */
export function browserLabelFromProjectName(projectName: string | undefined, fallback = 'browser'): string {
  return projectName === undefined || projectName === '' ? fallback : projectName
}

/**
 * Root-relative file path tokens ('tests', 'button.test.ts') for sidebar
 * grouping. Reporters and Vitest discovery both derive them from the test
 * file's path relative to the runner's root, so the sidebar tree keeps the
 * same shape before, during, and after a run.
 */
export function relativeFileTokens(root: string, file: string): string[] {
  return relative(root, file).split(/[/\\]/)
}

export function getBrowserName(testCase: TestCase): string {
  return browserLabelFromProjectName(
    testCase.project.name,
    testCase.project.config.browser.instances?.[0]?.browser ?? 'browser',
  )
}

export function getImageNameFromPath(filePath: string, browser: string): string {
  let imageName = basename(filePath).replace(/\.[^.]+$/, '')

  // Vitest writes both `<image>-<browser>-<platform>-<role>` and
  // `<image>-<role>-<browser>-<platform>` attachment layouts; strip whichever
  // suffixes are present until neither matches.
  let stripped = true
  while (stripped) {
    stripped = false
    const roleMatch = imageName.match(/-(actual|diff)$/)
    if (roleMatch !== null) {
      imageName = imageName.slice(0, roleMatch.index)
      stripped = true
      continue
    }
    const platformSuffix = `-${browser}-${process.platform}`
    if (imageName.endsWith(platformSuffix)) {
      imageName = imageName.slice(0, -platformSuffix.length)
      stripped = true
    }
  }

  return imageName
}

export function buildReferencePath(
  root: string,
  referenceDir: string,
  testFile: string,
  imageName: string,
  browser: string,
): string {
  const testFileDirectory = dirname(relative(root, testFile))
  const testFileName = basename(testFile)

  return join(root, testFileDirectory, referenceDir, testFileName, `${imageName}-${browser}-${process.platform}.png`)
}

export function buildAttachmentPath(
  root: string,
  attachmentsDir: string,
  testFile: string,
  imageName: string,
  browser: string,
  role: 'actual' | 'diff',
): string {
  const testFileDirectory = dirname(relative(root, testFile))
  const testFileName = basename(testFile)

  return join(
    root,
    attachmentsDir,
    testFileDirectory,
    testFileName,
    `${imageName}-${browser}-${process.platform}-${role}.png`,
  )
}

function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE, '')
}

export function parseVitestScreenshotError(error: string | undefined, browser: string): ParsedVitestImagePaths[] {
  if (error === undefined) return []

  const cleanError = stripAnsi(error)
  const references = Array.from(cleanError.matchAll(/Reference screenshot:\s*\n\s*(.+)/g))
  if (references.length === 0) return []

  const actuals = Array.from(cleanError.matchAll(/Actual screenshot:\s*\n\s*(.+)/g))
  const diffs = Array.from(cleanError.matchAll(/Diff image:\s*\n\s*(.+)/g))

  return references.map((referenceMatch, index) => {
    const referencePath = referenceMatch[1]?.trim()
    const actualPath = actuals[index]?.[1]?.trim()
    const diffPath = diffs[index]?.[1]?.trim()
    const imageName = getImageNameFromPath(actualPath ?? diffPath ?? referencePath ?? '', browser)

    return {
      imageName,
      referencePath,
      actualPath,
      diffPath,
    }
  })
}

export function mapVitestStatus(state: VitestTaskState): VitestStatus {
  switch (state) {
    case 'passed':
      return 'passed'
    case 'failed':
      return 'failed'
    case 'pending':
    case 'skipped':
      return 'skipped'
  }
}

/** Vitest reports its config file on either the test config or the Vite one. */
export function resolveVitestConfigFile(vitest: Vitest): string | undefined {
  const fromTestConfig = (vitest.config as ResolvedConfig & { configFile?: string | false }).configFile
  if (typeof fromTestConfig === 'string') return fromTestConfig
  const fromViteConfig = vitest.vite.config.configFile
  return typeof fromViteConfig === 'string' ? fromViteConfig : undefined
}
