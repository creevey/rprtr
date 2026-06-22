import { readdir } from 'fs/promises'
import { join } from 'path'

import pLimit from 'p-limit'

import { applyTestBeginEvent, applyTestEndEvent, createMutableReportState, finalizeRunEvent } from './report-state.ts'
import {
  OfflineReportSchema,
  TestBeginDataSchema,
  TestEndDataSchema,
  safeParse,
  type OfflineReport as ParsedOfflineReport,
} from './schemas.ts'
import { readJsonFile } from './server/file-utils.ts'
import type { TestData } from './types.ts'

const MAX_CONCURRENT_FILE_OPS = 5
const OFFLINE_REPORT_FILE_PATTERN = /^crvy-rprtr(?:-\d+)?\.json$/

export async function findOfflineReportPaths(searchDir: string): Promise<string[]> {
  try {
    const entries = await readdir(searchDir)
    return entries
      .filter((entry) => OFFLINE_REPORT_FILE_PATTERN.test(entry))
      .sort((left, right) => left.localeCompare(right))
      .map((entry) => join(searchDir, entry))
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return []
    }

    throw error
  }
}

export function parseOfflineReport(value: unknown): ParsedOfflineReport | null {
  const parsed = safeParse(OfflineReportSchema, value)
  if (parsed === null || parsed.version !== 1 || !Array.isArray(parsed.events)) {
    return null
  }

  return parsed
}

async function readOfflineReport(filePath: string): Promise<ParsedOfflineReport | null> {
  try {
    const raw = await readJsonFile(filePath)
    if (raw === null) {
      return null
    }

    const parsed = parseOfflineReport(raw)
    if (parsed !== null) {
      console.log(`[Server] Loading offline report: ${filePath}`)
      return parsed
    }
  } catch {
    // Skip invalid files
  }

  return null
}

export async function loadOfflineReports(
  reportData: { tests: Record<string, TestData>; screenshotDir: string },
  offlineReportDir: string,
): Promise<void> {
  const offlineReportPaths = await findOfflineReportPaths(offlineReportDir)
  if (offlineReportPaths.length === 0) {
    return
  }

  const limit = pLimit(MAX_CONCURRENT_FILE_OPS)
  const reports = await Promise.all(offlineReportPaths.map((filePath) => limit(() => readOfflineReport(filePath))))
  const validReports = reports.filter((report): report is ParsedOfflineReport => report !== null)
  if (validReports.length === 0) {
    return
  }

  reportData.tests = mergeOfflineReportsIntoTests(reportData.tests, validReports, {
    screenshotDir: reportData.screenshotDir,
    screenshotsBaseUrl: '/screenshots/',
  })
}

export function mergeOfflineReportsIntoTests(
  existingTests: Record<string, TestData>,
  offlineReports: ParsedOfflineReport[],
  options: { screenshotDir?: string; screenshotsBaseUrl?: string } = {},
): Record<string, TestData> {
  const state = createMutableReportState(options.screenshotDir)
  let shouldFinalize = false

  for (const report of offlineReports) {
    for (const event of report.events) {
      switch (event.type) {
        case 'test-begin': {
          const parsed = safeParse(TestBeginDataSchema, event.data)
          if (parsed !== null) {
            applyTestBeginEvent(state, parsed)
          }
          break
        }
        case 'test-end': {
          const parsed = safeParse(TestEndDataSchema, event.data)
          if (parsed !== null) {
            applyTestEndEvent(state, parsed, { screenshotsBaseUrl: options.screenshotsBaseUrl })
          }
          break
        }
        case 'run-end':
          shouldFinalize = true
          break
      }
    }
  }

  if (shouldFinalize) {
    finalizeRunEvent(state)
  }

  return {
    ...existingTests,
    ...state.reportData.tests,
  }
}
