import { describe, expect, test } from 'bun:test'

import { findTreePathCollisions, warnTreePathCollisions } from '../src/report-tree'
import type { TestData } from '../src/types'

function makeTest(overrides: Partial<TestData> = {}): TestData {
  return {
    id: 'test-1',
    titlePath: [],
    title: 'Test',
    browser: 'chromium',
    location: { file: 'tests/example.spec.ts', line: 1 },
    status: 'pending',
    results: [],
    ...overrides,
  }
}

function testsById(...entries: TestData[]): Record<string, TestData> {
  return Object.fromEntries(entries.map((entry) => [entry.id, entry]))
}

describe('findTreePathCollisions', () => {
  test('groups two tests that share the same authored path and project', () => {
    const collisions = findTreePathCollisions(
      testsById(
        makeTest({ id: 'first', titlePath: ['Components/Button'], title: 'Primary' }),
        makeTest({ id: 'second', titlePath: ['Components/Button'], title: 'Primary' }),
      ),
    )

    expect(collisions).toHaveLength(1)
    expect(collisions[0]?.path).toEqual(['Components', 'Button', 'Primary', 'chromium'])
    expect(collisions[0]?.tests.map(({ id }) => id).sort()).toEqual(['first', 'second'])
    expect(collisions[0]?.tests.map(({ title }) => title)).toEqual(['Primary', 'Primary'])
  })

  test('does not group tests that differ by project leaf', () => {
    const collisions = findTreePathCollisions(
      testsById(
        makeTest({ id: 'dark', titlePath: ['Components/Button'], title: 'Primary', browser: 'dark' }),
        makeTest({ id: 'mobile', titlePath: ['Components/Button'], title: 'Primary', browser: 'mobile' }),
      ),
    )

    expect(collisions).toEqual([])
  })

  test('does not group a manual interaction test beneath a story', () => {
    const collisions = findTreePathCollisions(
      testsById(
        makeTest({ id: 'visual', titlePath: ['Components/Button'], title: 'Primary' }),
        makeTest({ id: 'manual', titlePath: ['Components/Button', 'Primary'], title: 'opens menu' }),
      ),
    )

    expect(collisions).toEqual([])
  })

  test('excludes discovered placeholders from collisions', () => {
    const collisions = findTreePathCollisions(
      testsById(
        makeTest({
          id: 'discovered:tests/button.spec.ts:chromium:Components > Button > Primary',
          titlePath: ['Components/Button'],
          title: 'Primary',
        }),
        makeTest({ id: 'live', titlePath: ['Components/Button'], title: 'Primary' }),
      ),
    )

    expect(collisions).toEqual([])
  })

  test('does not group plain tests that differ only by file', () => {
    const collisions = findTreePathCollisions(
      testsById(
        makeTest({ id: 'first', titlePath: [], title: 'plain test', fileTokens: ['tests', 'first.spec.ts'] }),
        makeTest({ id: 'second', titlePath: [], title: 'plain test', fileTokens: ['tests', 'second.spec.ts'] }),
      ),
    )

    expect(collisions).toEqual([])
  })
})

describe('warnTreePathCollisions', () => {
  test('warns about a distinct collision only once per reported set', () => {
    const tests = testsById(
      makeTest({ id: 'first', titlePath: ['Components/Button'], title: 'Primary' }),
      makeTest({ id: 'second', titlePath: ['Components/Button'], title: 'Primary' }),
    )
    const reported = new Set<string>()
    const warnings: string[] = []

    warnTreePathCollisions(tests, reported, (message) => warnings.push(message))
    warnTreePathCollisions(tests, reported, (message) => warnings.push(message))

    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('Components/Button/Primary/chromium')
    expect(warnings[0]).toContain('"Primary" (first)')
    expect(warnings[0]).toContain('"Primary" (second)')
  })

  test('warns again when a new collision group appears', () => {
    const reported = new Set<string>()
    const warnings: string[] = []
    warnTreePathCollisions(
      testsById(
        makeTest({ id: 'first', titlePath: ['Components/Button'], title: 'Primary' }),
        makeTest({ id: 'second', titlePath: ['Components/Button'], title: 'Primary' }),
      ),
      reported,
      (message) => warnings.push(message),
    )
    warnTreePathCollisions(
      testsById(
        makeTest({ id: 'third', titlePath: ['Components/Input'], title: 'Default' }),
        makeTest({ id: 'fourth', titlePath: ['Components/Input'], title: 'Default' }),
      ),
      reported,
      (message) => warnings.push(message),
    )

    expect(warnings).toHaveLength(2)
    expect(warnings[1]).toContain('Components/Input/Default/chromium')
  })
})
