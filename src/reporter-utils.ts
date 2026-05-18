import type { TestStep } from '@playwright/test/reporter'

const NAMED_SCREENSHOT_STEP_TITLE = /toHaveScreenshot\((.+?)\)/
const UNNAMED_SCREENSHOT_STEP_TITLE = /^Expect "toHaveScreenshot"(?:\s|$)/
const SYNTHETIC_SCREENSHOT_PREFIX = '__unnamed-screenshot-'

export interface NamedScreenshotDeclaration {
  visualName: string
  kind: 'named'
  declaredName: string
  snapshotBaseName: string
  occurrenceIndex: number
}

export interface UnnamedScreenshotDeclaration {
  visualName: string
  kind: 'unnamed'
  occurrenceIndex: number
}

export type ScreenshotDeclaration = NamedScreenshotDeclaration | UnnamedScreenshotDeclaration

export interface AttachmentData {
  name: string
  path: string
  contentType: string
}

interface ExtractionState {
  readonly declarations: ScreenshotDeclaration[]
  readonly namedOccurrences: Map<string, number>
  nextUnnamedIndex: number
}

function addVisualSuffix(visualName: string, occurrenceIndex: number): string {
  if (occurrenceIndex === 1) {
    return visualName
  }

  const slashIndex = visualName.lastIndexOf('/')

  return slashIndex === -1
    ? `${visualName}-${occurrenceIndex - 1}`
    : `${visualName.slice(0, slashIndex + 1)}${visualName.slice(slashIndex + 1)}-${occurrenceIndex - 1}`
}

function normalizeNamedScreenshot(titleMatch: string, state: ExtractionState): NamedScreenshotDeclaration | null {
  const unquotedName = titleMatch.trim().replace(/^['"`]|['"`]$/g, '')

  if (unquotedName === '') {
    return null
  }

  const normalizedPath = unquotedName.replace(/\\/g, '/')
  const declaredName = normalizedPath.replace(/\.png$/, '')

  if (declaredName === '') {
    return null
  }

  const occurrenceIndex = (state.namedOccurrences.get(declaredName) ?? 0) + 1
  state.namedOccurrences.set(declaredName, occurrenceIndex)

  return {
    visualName: addVisualSuffix(declaredName, occurrenceIndex),
    kind: 'named',
    declaredName,
    snapshotBaseName: declaredName,
    occurrenceIndex,
  }
}

function visitStep(step: TestStep, state: ExtractionState): boolean {
  const declarationsBeforeChildren = state.declarations.length

  for (const nestedStep of step.steps) {
    visitStep(nestedStep, state)
  }

  const namedMatch = step.title.match(NAMED_SCREENSHOT_STEP_TITLE)
  if (namedMatch?.[1] !== undefined) {
    const declaration = normalizeNamedScreenshot(namedMatch[1], state)
    if (declaration !== null) {
      state.declarations.push(declaration)
      return true
    }
  }

  const hasNestedScreenshotDeclaration = state.declarations.length > declarationsBeforeChildren

  if (UNNAMED_SCREENSHOT_STEP_TITLE.test(step.title) && !hasNestedScreenshotDeclaration) {
    const occurrenceIndex = state.nextUnnamedIndex
    state.declarations.push({
      visualName: `${SYNTHETIC_SCREENSHOT_PREFIX}${occurrenceIndex}`,
      kind: 'unnamed',
      occurrenceIndex,
    })
    state.nextUnnamedIndex += 1
    return true
  }

  return hasNestedScreenshotDeclaration
}

export function extractScreenshotDeclarations(steps: readonly TestStep[]): ScreenshotDeclaration[] {
  const state: ExtractionState = {
    declarations: [],
    namedOccurrences: new Map(),
    nextUnnamedIndex: 1,
  }

  for (const step of steps) {
    visitStep(step, state)
  }

  return state.declarations
}

export function extractScreenshotNames(steps: readonly TestStep[]): string[] {
  return extractScreenshotDeclarations(steps).map(({ visualName }) => visualName)
}
