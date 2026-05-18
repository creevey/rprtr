import { expect, test } from 'bun:test'

import type { TestStep } from '@playwright/test/reporter'

import { extractScreenshotDeclarations } from '../src/reporter-utils'

function createStep(title: string, steps: readonly TestStep[] = []): TestStep {
  return {
    title,
    steps: [...steps],
    titlePath: () => [title],
    annotations: [],
    attachments: [],
    category: 'expect',
    duration: 0,
    startTime: new Date(0),
  }
}

test('extractScreenshotDeclarations keeps duplicate names distinct and preserves unnamed ordering', () => {
  expect(
    extractScreenshotDeclarations([
      createStep('outer step', [
        createStep('Expect "toHaveScreenshot(header.png)"'),
        createStep('Expect "toHaveScreenshot"'),
        createStep('Expect "toHaveScreenshot(header.png)"'),
        createStep('Expect "toHaveScreenshot"'),
      ]),
    ]),
  ).toEqual([
    {
      visualName: 'header',
      kind: 'named',
      declaredName: 'header',
      snapshotBaseName: 'header',
      occurrenceIndex: 1,
    },
    {
      visualName: '__unnamed-screenshot-1',
      kind: 'unnamed',
      occurrenceIndex: 1,
    },
    {
      visualName: 'header-1',
      kind: 'named',
      declaredName: 'header',
      snapshotBaseName: 'header',
      occurrenceIndex: 2,
    },
    {
      visualName: '__unnamed-screenshot-2',
      kind: 'unnamed',
      occurrenceIndex: 2,
    },
  ])
})
