import { OfflineReportSchema } from '../src/schemas'

/**
 * A browser-mode `vitest run` with no launchable browser exits having executed
 * nothing, and its offline report carries a lone `run-end` event. Without this
 * guard that surfaced several assertions later as an event-list mismatch, which
 * read like a reporter bug rather than a missing browser — and a test file that
 * silently executes zero tests is the failure mode worth designing against.
 */
export function assertRunExecutedTests(reportContent: unknown, source: string): void {
  if (reportContent === undefined) {
    throw new Error(`${source} wrote no offline report — the run executed nothing. Is a browser available?`)
  }

  const report = OfflineReportSchema.parse(reportContent)
  const started = report.events.filter((event) => event.type === 'test-begin').length
  if (started === 0) {
    throw new Error(
      `${source} executed no tests: the report holds ${report.events.length} event(s) and no test began. ` +
        'Is a browser available?',
    )
  }
}
