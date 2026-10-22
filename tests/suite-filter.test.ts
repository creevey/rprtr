import { describe, expect, test } from 'bun:test'

import { filterTests } from '../src/client/helpers'
import type { CrvyRprtrViewFilter } from '../src/client/helpers'
import { isTest, type CrvyRprtrSuite, type CrvyRprtrTest, type TestResult, type TestStatus } from '../src/types'

function testWith(overrides: Partial<CrvyRprtrTest> = {}): CrvyRprtrTest {
  return {
    id: 'test-1',
    title: 'visual test',
    titlePath: [],
    browser: 'chromium',
    checked: false,
    ...overrides,
  }
}

function suiteWith(
  children: Record<string, CrvyRprtrTest | CrvyRprtrSuite>,
  overrides: Partial<CrvyRprtrSuite> = {},
): CrvyRprtrSuite {
  return { path: [], skip: false, opened: true, checked: true, indeterminate: false, children, ...overrides }
}

function result(overrides: Partial<TestResult> = {}): TestResult {
  return { status: 'success', retries: 0, ...overrides }
}

function filter(status: TestStatus | null = null, subStrings: string[] = []): CrvyRprtrViewFilter {
  return { status, subStrings }
}

function visibleTitles(suite: CrvyRprtrSuite): string[] {
  return Object.entries(suite.children ?? {}).flatMap(([title, child]) =>
    child && !isTest(child) ? visibleTitles(child) : [title],
  )
}

function childSuite(suite: CrvyRprtrSuite, title: string): CrvyRprtrSuite {
  const child = suite.children?.[title]
  if (!child || isTest(child)) throw new Error(`missing suite ${title}`)
  return child
}

describe('filterTests status matching', () => {
  test('status:failed keeps failed and running tests and excludes skipped, discovered, and passed tests', () => {
    const suite = suiteWith({
      failed: testWith({ id: 'failed', title: 'failed', status: 'failed', results: [result({ status: 'failed' })] }),
      skipped: testWith({
        id: 'skipped',
        title: 'skipped',
        status: 'pending',
        results: [result({ status: 'pending' })],
      }),
      discovered: testWith({ id: 'discovered', title: 'discovered', status: 'pending' }),
      running: testWith({ id: 'running', title: 'running', status: 'running' }),
      passed: testWith({ id: 'passed', title: 'passed', status: 'success' }),
    })

    expect(visibleTitles(filterTests(suite, filter('failed')))).toEqual(['failed', 'running'])
  })

  test('status:failed keeps a rerun visible until it passes, then drops it', () => {
    const rerun = testWith({ id: 'rerun', title: 'rerun', status: 'failed' })
    const suite = suiteWith({ rerun })

    expect(visibleTitles(filterTests(suite, filter('failed')))).toEqual(['rerun'])

    rerun.status = 'running'
    expect(visibleTitles(filterTests(suite, filter('failed')))).toEqual(['rerun'])

    rerun.status = 'success'
    expect(visibleTitles(filterTests(suite, filter('failed')))).toEqual([])

    rerun.status = 'failed'
    expect(visibleTitles(filterTests(suite, filter('failed')))).toEqual(['rerun'])
  })

  test('status:pending includes skipped and never-run tests only', () => {
    const suite = suiteWith({
      skipped: testWith({
        id: 'skipped',
        title: 'skipped',
        status: 'pending',
        results: [result({ status: 'pending' })],
      }),
      discovered: testWith({ id: 'discovered', title: 'discovered', status: 'pending' }),
      failed: testWith({ id: 'failed', title: 'failed', status: 'failed' }),
      success: testWith({ id: 'success', title: 'success', status: 'success' }),
      approved: testWith({ id: 'approved', title: 'approved', status: 'approved' }),
      running: testWith({ id: 'running', title: 'running', status: 'running' }),
    })

    expect(visibleTitles(filterTests(suite, filter('pending')))).toEqual(['skipped', 'discovered'])
  })

  test('status:success includes successful tests and excludes approved tests', () => {
    const suite = suiteWith({
      success: testWith({ id: 'success', title: 'success', status: 'success' }),
      approved: testWith({ id: 'approved', title: 'approved', status: 'approved' }),
      pending: testWith({ id: 'pending', title: 'pending', status: 'pending' }),
      running: testWith({ id: 'running', title: 'running', status: 'running' }),
    })

    expect(visibleTitles(filterTests(suite, filter('success')))).toEqual(['success'])
  })

  test('status:approved includes approved tests and excludes successful tests', () => {
    const suite = suiteWith({
      success: testWith({ id: 'success', title: 'success', status: 'success' }),
      approved: testWith({ id: 'approved', title: 'approved', status: 'approved' }),
      pending: testWith({ id: 'pending', title: 'pending', status: 'pending' }),
      running: testWith({ id: 'running', title: 'running', status: 'running' }),
    })

    expect(visibleTitles(filterTests(suite, filter('approved')))).toEqual(['approved'])
  })
})

describe('filterTests suite hierarchy', () => {
  test('keeps only the ancestor chain to matching tests and omits non-matching branches', () => {
    const suite = suiteWith({
      components: suiteWith({
        button: suiteWith({
          primary: testWith({ id: 'primary', title: 'primary', status: 'failed' }),
        }),
        input: suiteWith({
          default: testWith({
            id: 'default',
            title: 'default',
            status: 'pending',
            results: [result({ status: 'pending' })],
          }),
        }),
      }),
      utils: suiteWith({
        helper: testWith({ id: 'helper', title: 'helper', status: 'success' }),
      }),
    })

    const filtered = filterTests(suite, filter('failed'))

    expect(Object.keys(filtered.children ?? {})).toEqual(['components'])
    expect(Object.keys(childSuite(filtered, 'components').children ?? {})).toEqual(['button'])
    expect(visibleTitles(filtered)).toEqual(['primary'])
  })

  test('omits a group when no descendant test matches', () => {
    const suite = suiteWith({
      components: suiteWith({
        button: suiteWith({
          primary: testWith({ id: 'primary', title: 'primary', status: 'success' }),
        }),
      }),
      utils: suiteWith({
        helper: testWith({ id: 'helper', title: 'helper', status: 'pending' }),
      }),
    })

    const filtered = filterTests(suite, filter('failed'))

    expect(Object.keys(filtered.children ?? {})).toEqual([])
  })
})

describe('filterTests view-only behavior', () => {
  test('does not mutate test statuses, results, approvals, or suite statuses', () => {
    const failed = testWith({
      id: 'failed',
      title: 'failed',
      status: 'failed',
      results: [result({ status: 'failed', error: 'boom' })],
      approved: { header: 0 },
    })
    const skipped = testWith({
      id: 'skipped',
      title: 'skipped',
      status: 'pending',
      results: [result({ status: 'pending' })],
    })
    const suite = suiteWith(
      {
        failed,
        skipped,
        nested: suiteWith({ passed: testWith({ id: 'passed', title: 'passed', status: 'success' }) }),
      },
      { status: 'failed' },
    )
    const before = JSON.stringify(suite)

    const filtered = filterTests(suite, filter('failed'))
    filterTests(suite, filter())
    filterTests(suite, filter(null, ['failed']))

    expect(JSON.stringify(suite)).toBe(before)
    expect(failed.status).toBe('failed')
    expect(failed.results).toEqual([result({ status: 'failed', error: 'boom' })])
    expect(failed.approved).toEqual({ header: 0 })
    expect(suite.status).toBe('failed')
    expect(filtered.children?.failed).toBe(failed)
  })
})

describe('filterTests text and combined filters', () => {
  test('text-only matching keeps a matching suite with all of its descendants', () => {
    const suite = suiteWith({
      Button: suiteWith({
        Primary: testWith({ id: 'primary', title: 'Primary', status: 'success' }),
        Secondary: testWith({ id: 'secondary', title: 'Secondary', status: 'failed' }),
      }),
      Input: suiteWith({
        Default: testWith({ id: 'default', title: 'Default', status: 'success' }),
      }),
    })

    const filtered = filterTests(suite, filter(null, ['button']))

    expect(Object.keys(filtered.children ?? {})).toEqual(['Button'])
    expect(visibleTitles(filtered)).toEqual(['Primary', 'Secondary'])
  })

  test('text-only matching also selects individual tests by title', () => {
    const suite = suiteWith({
      'Button primary': testWith({ id: 'primary', title: 'Button primary', status: 'success' }),
      'Input default': testWith({ id: 'default', title: 'Input default', status: 'success' }),
    })

    expect(visibleTitles(filterTests(suite, filter(null, ['button'])))).toEqual(['Button primary'])
  })

  test('a status plus text applies the status filter only, as before', () => {
    const suite = suiteWith({
      'Button primary': testWith({ id: 'primary', title: 'Button primary', status: 'success' }),
      'Input default': testWith({ id: 'default', title: 'Input default', status: 'failed' }),
    })

    expect(visibleTitles(filterTests(suite, filter('failed', ['button'])))).toEqual(['Input default'])
  })
})
