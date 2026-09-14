import { expect, test } from 'bun:test'

import type { TestCase } from 'vitest/node'

import {
  buildAttachmentPath,
  buildReferencePath,
  getBrowserName,
  getImageNameFromPath,
  getTitlePath,
  mapVitestStatus,
  parseVitestScreenshotError,
} from '../src/vitest-helpers'

type MockTaskState = 'passed' | 'failed' | 'skipped' | 'pending'

interface MockVitestError {
  readonly message: string
}

interface MockVitestResult {
  readonly state: MockTaskState
  readonly errors: readonly MockVitestError[]
}

interface MockVitestDiagnostic {
  readonly duration: number
}

interface MockVitestAttachment {
  readonly contentType: string
  readonly height: number
  readonly name: string
  readonly path: string
  readonly width: number
}

interface MockVitestArtifact {
  readonly attachments: readonly MockVitestAttachment[]
  readonly kind: 'visual-regression'
  readonly message: string
  readonly type: 'internal:toMatchScreenshot'
}

interface MockVitestProject {
  readonly config: { readonly browser: { readonly instances?: readonly { readonly browser: string }[] } }
  readonly name: string
}

interface MockVitestParent {
  readonly name: string
  readonly parent?: MockVitestParent
  readonly type: 'suite' | 'module'
}

interface MockVitestCase {
  readonly artifacts: () => readonly MockVitestArtifact[]
  readonly diagnostic: () => MockVitestDiagnostic
  readonly id: string
  readonly location: { readonly column: number; readonly line: number }
  readonly module: { readonly moduleId: string }
  readonly name: string
  readonly parent: MockVitestParent
  readonly project: MockVitestProject
  readonly result: () => MockVitestResult
}

interface CreateTestCaseOptions {
  readonly artifacts?: readonly MockVitestArtifact[]
  readonly browser?: string
  readonly errors?: readonly MockVitestError[]
  readonly file: string
  readonly id: string
  readonly line?: number
  readonly name: string
  readonly projectName?: string
  readonly state?: MockTaskState
  readonly suiteNames?: readonly string[]
}

function createParentChain(suiteNames: readonly string[]): MockVitestParent {
  let parent: MockVitestParent = { name: 'module', type: 'module' }
  for (const suiteName of suiteNames) {
    parent = { name: suiteName, parent, type: 'suite' }
  }
  return parent
}

function createTestCase(options: CreateTestCaseOptions): MockVitestCase {
  const browser = options.browser ?? 'chromium'
  return {
    id: options.id,
    name: options.name,
    location: { line: options.line ?? 7, column: 1 },
    module: { moduleId: options.file },
    parent: createParentChain(options.suiteNames ?? []),
    project: {
      name: options.projectName ?? browser,
      config: {
        browser: {
          instances: [{ browser }],
        },
      },
    },
    artifacts: (): readonly MockVitestArtifact[] => options.artifacts ?? [],
    result: (): MockVitestResult => ({
      state: options.state ?? 'failed',
      errors: options.errors ?? [],
    }),
    diagnostic: (): MockVitestDiagnostic => ({ duration: 42 }),
  }
}

function asTestCase(mock: MockVitestCase): TestCase {
  return mock as unknown as TestCase
}

interface ErrorBuilderPaths {
  readonly actual?: string
  readonly diff?: string
  readonly reference: string
}

function buildScreenshotError(paths: readonly ErrorBuilderPaths[]): string {
  const sections = paths.map(({ reference, actual, diff }) => {
    const lines = [
      `\nReference screenshot:\n  \u001B[32m${reference}\u001B[39m`,
      actual === undefined ? null : `\nActual screenshot:\n  \u001B[31m${actual}\u001B[39m`,
      diff === undefined ? null : `\u001B[2m\nDiff image:\n  ${diff}\u001B[22m`,
      '',
    ]
    return lines.filter((line): line is string => line !== null).join('\n')
  })
  return [
    'expect(page.getByTestId("hero")).toMatchScreenshot()',
    '',
    'Screenshot does not match the stored reference.',
    ...sections,
  ].join('\n')
}

test('getTitlePath collects suite names up to the module', () => {
  const testCase = asTestCase(
    createTestCase({
      id: 't-1',
      name: 'renders hero',
      file: '/proj/tests/hero.test.ts',
      suiteNames: ['outer', 'inner'],
    }),
  )
  expect(getTitlePath(testCase)).toEqual(['outer', 'inner'])
})

test('getTitlePath returns empty path for a module-level test', () => {
  const testCase = asTestCase(
    createTestCase({ id: 't-2', name: 'top level', file: '/proj/tests/hero.test.ts', suiteNames: [] }),
  )
  expect(getTitlePath(testCase)).toEqual([])
})

test('getBrowserName prefers the project name', () => {
  const testCase = asTestCase(
    createTestCase({ id: 't-3', name: 'named', file: '/proj/tests/hero.test.ts', projectName: 'desktop-chrome' }),
  )
  expect(getBrowserName(testCase)).toBe('desktop-chrome')
})

test('getBrowserName falls back to the browser instance when the project name is empty', () => {
  const mock = createTestCase({ id: 't-4', name: 'unnamed project', file: '/proj/tests/hero.test.ts', projectName: '' })
  const testCase = asTestCase(mock)
  expect(getBrowserName(testCase)).toBe('chromium')
})

test('getBrowserName falls back to a generic label when no instance is configured', () => {
  const mock = createTestCase({ id: 't-5', name: 'no instances', file: '/proj/tests/hero.test.ts', projectName: '' })
  const withNoInstances: MockVitestProject = {
    name: '',
    config: { browser: { instances: [] } },
  }
  const testCase = asTestCase({ ...mock, project: withNoInstances })
  expect(getBrowserName(testCase)).toBe('browser')
})

test('getImageNameFromPath strips the browser and platform suffixes', () => {
  expect(getImageNameFromPath(`/p/hero-section-chromium-${process.platform}.png`, 'chromium')).toBe('hero-section')
})

test('getImageNameFromPath strips actual and diff role suffixes', () => {
  expect(getImageNameFromPath(`/p/hero-section-chromium-${process.platform}-actual.png`, 'chromium')).toBe(
    'hero-section',
  )
  expect(getImageNameFromPath(`/p/hero-section-chromium-${process.platform}-diff.png`, 'chromium')).toBe('hero-section')
})

test('getImageNameFromPath keeps the name when the browser suffix does not match', () => {
  expect(getImageNameFromPath(`/p/hero-section-firefox-${process.platform}.png`, 'chromium')).toBe(
    `hero-section-firefox-${process.platform}`,
  )
})

test('getImageNameFromPath keeps plain names untouched', () => {
  expect(getImageNameFromPath('/p/hero-section.png', 'chromium')).toBe('hero-section')
})

test('buildReferencePath resolves the default __screenshots__ layout', () => {
  const path = buildReferencePath('/proj', '__screenshots__', '/proj/tests/hero.test.ts', 'hero-section', 'chromium')
  expect(path).toBe(`/proj/tests/__screenshots__/hero.test.ts/hero-section-chromium-${process.platform}.png`)
})

test('buildReferencePath honors an explicit reference dir', () => {
  const path = buildReferencePath('/proj', 'custom-refs', '/proj/tests/hero.test.ts', 'hero-section', 'chromium')
  expect(path).toBe(`/proj/tests/custom-refs/hero.test.ts/hero-section-chromium-${process.platform}.png`)
})

test('buildReferencePath handles a test file directly in the root', () => {
  const path = buildReferencePath('/proj', '__screenshots__', '/proj/hero.test.ts', 'hero-section', 'chromium')
  expect(path).toBe(`/proj/__screenshots__/hero.test.ts/hero-section-chromium-${process.platform}.png`)
})

test('buildAttachmentPath resolves the default .vitest-attachments layout', () => {
  const actual = buildAttachmentPath(
    '/proj',
    '.vitest-attachments',
    '/proj/tests/hero.test.ts',
    'hero-section',
    'chromium',
    'actual',
  )
  const diff = buildAttachmentPath(
    '/proj',
    '.vitest-attachments',
    '/proj/tests/hero.test.ts',
    'hero-section',
    'chromium',
    'diff',
  )
  expect(actual).toBe(
    `/proj/.vitest-attachments/tests/hero.test.ts/hero-section-chromium-${process.platform}-actual.png`,
  )
  expect(diff).toBe(`/proj/.vitest-attachments/tests/hero.test.ts/hero-section-chromium-${process.platform}-diff.png`)
})

test('buildAttachmentPath honors an explicit attachments dir', () => {
  const path = buildAttachmentPath(
    '/proj',
    'custom-attachments',
    '/proj/tests/hero.test.ts',
    'hero-section',
    'chromium',
    'actual',
  )
  expect(path).toBe(`/proj/custom-attachments/tests/hero.test.ts/hero-section-chromium-${process.platform}-actual.png`)
})

test('mapVitestStatus maps passed and failed directly', () => {
  expect(mapVitestStatus('passed')).toBe('passed')
  expect(mapVitestStatus('failed')).toBe('failed')
})

test('mapVitestStatus maps pending and skipped to skipped', () => {
  expect(mapVitestStatus('pending')).toBe('skipped')
  expect(mapVitestStatus('skipped')).toBe('skipped')
})

test('parseVitestScreenshotError extracts all three paths from an ANSI-colored failure', () => {
  const referencePath = `/p/tests/__screenshots__/hero.test.ts/hero-section-chromium-${process.platform}.png`
  const actualPath = `/p/.vitest-attachments/tests/hero.test.ts/hero-section-chromium-${process.platform}-actual.png`
  const diffPath = `/p/.vitest-attachments/tests/hero.test.ts/hero-section-chromium-${process.platform}-diff.png`
  const error = buildScreenshotError([{ reference: referencePath, actual: actualPath, diff: diffPath }])

  expect(parseVitestScreenshotError(error, 'chromium')).toEqual([
    {
      imageName: 'hero-section',
      referencePath,
      actualPath,
      diffPath,
    },
  ])
})

test('parseVitestScreenshotError parses a message without ANSI colors', () => {
  const referencePath = `/p/tests/__screenshots__/hero.test.ts/hero-section-chromium-${process.platform}.png`
  const actualPath = `/p/.vitest-attachments/tests/hero.test.ts/hero-section-chromium-${process.platform}-actual.png`
  const diffPath = `/p/.vitest-attachments/tests/hero.test.ts/hero-section-chromium-${process.platform}-diff.png`
  const error = [
    'expect(page.getByTestId("hero")).toMatchScreenshot()',
    '',
    'Screenshot does not match the stored reference.',
    `\nReference screenshot:\n  ${referencePath}`,
    `\nActual screenshot:\n  ${actualPath}`,
    `\nDiff image:\n  ${diffPath}`,
    '',
  ].join('\n')

  expect(parseVitestScreenshotError(error, 'chromium')).toEqual([
    {
      imageName: 'hero-section',
      referencePath,
      actualPath,
      diffPath,
    },
  ])
})

test('parseVitestScreenshotError yields a reference-only entry for first-run baselines', () => {
  const referencePath = `/p/tests/__screenshots__/hero.test.ts/hero-section-chromium-${process.platform}.png`
  const error = [
    'expect(page.getByTestId("hero")).toMatchScreenshot()',
    '',
    'No existing reference screenshot found; a new one was created. Review it before running tests again.',
    `\nReference screenshot:\n  \u001B[32m${referencePath}\u001B[39m`,
    '',
  ].join('\n')

  expect(parseVitestScreenshotError(error, 'chromium')).toEqual([
    {
      imageName: 'hero-section',
      referencePath,
      actualPath: undefined,
      diffPath: undefined,
    },
  ])
})

test('parseVitestScreenshotError extracts one entry per screenshot in a multi-screenshot failure', () => {
  const first = `/p/tests/__screenshots__/hero.test.ts/first-chromium-${process.platform}.png`
  const firstActual = `/p/.vitest-attachments/tests/hero.test.ts/first-chromium-${process.platform}-actual.png`
  const second = `/p/tests/__screenshots__/hero.test.ts/second-chromium-${process.platform}.png`
  const secondActual = `/p/.vitest-attachments/tests/hero.test.ts/second-chromium-${process.platform}-actual.png`
  const error = buildScreenshotError([
    { reference: first, actual: firstActual },
    { reference: second, actual: secondActual },
  ])

  expect(parseVitestScreenshotError(error, 'chromium')).toEqual([
    { imageName: 'first', referencePath: first, actualPath: firstActual, diffPath: undefined },
    { imageName: 'second', referencePath: second, actualPath: secondActual, diffPath: undefined },
  ])
})

test('parseVitestScreenshotError returns an empty list for messages without screenshot lines', () => {
  expect(parseVitestScreenshotError('visual mismatch', 'chromium')).toEqual([])
})

test('parseVitestScreenshotError returns an empty list for undefined errors', () => {
  expect(parseVitestScreenshotError(undefined, 'chromium')).toEqual([])
})
