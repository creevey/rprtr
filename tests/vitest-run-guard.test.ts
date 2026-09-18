import { describe, expect, test } from 'bun:test'

import { assertRunExecutedTests } from './vitest-run-guard.ts'

function report(eventTypes: string[]): unknown {
  return {
    version: 1,
    generatedAt: '2026-09-18T00:00:00.000Z',
    workers: 1,
    events: eventTypes.map((type, index) => ({ type, data: {}, timestamp: index, workerIndex: 0 })),
  }
}

describe('assertRunExecutedTests', () => {
  test('accepts a run that began at least one test', () => {
    expect(() => assertRunExecutedTests(report(['test-begin', 'test-end', 'run-end']), 'fixture run')).not.toThrow()
  })

  // The browserless failure mode: vitest exits having run nothing, and the only
  // event is run-end. Left unguarded this surfaces as a confusing event-list
  // mismatch several assertions later.
  test('rejects a run that executed nothing, naming the run', () => {
    expect(() => assertRunExecutedTests(report(['run-end']), 'fixture run')).toThrow(
      /fixture run executed no tests.*browser/is,
    )
  })

  test('rejects a run that produced no report at all', () => {
    expect(() => assertRunExecutedTests(undefined, 'fixture run')).toThrow(/fixture run.*no offline report/is)
  })

  test('rejects a report that is not a valid offline report', () => {
    expect(() => assertRunExecutedTests({ version: 1 }, 'fixture run')).toThrow()
  })
})
