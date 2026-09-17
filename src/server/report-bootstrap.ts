import { dirname, join } from 'path'

import type { RunEnvironments } from '../browser-pins.ts'
import { LoadedReportDataSchema, safeParse } from '../schemas.ts'
import type { TestData } from '../types.ts'
import { isDirectory, readJsonFile } from './file-utils.ts'

export interface ReportData {
  isRunning: boolean
  tests: Record<string, TestData>
  browsers: string[]
  isUpdateMode: boolean
  screenshotDir: string
  environments: RunEnvironments
}

export function createReportData(screenshotDir?: string): ReportData {
  return {
    isRunning: false,
    tests: {},
    browsers: ['chromium'],
    isUpdateMode: false,
    screenshotDir: screenshotDir ?? './screenshots',
    environments: {},
  }
}

export async function loadReport(reportPath: string, reportData: ReportData): Promise<void> {
  try {
    const raw = await readJsonFile(reportPath)
    if (raw === null) {
      console.log('No report.json found, using empty state')
      return
    }

    const parsed = safeParse(LoadedReportDataSchema, raw)
    if (parsed !== null) {
      reportData.tests = parsed.tests ?? {}
      reportData.isUpdateMode = parsed.isUpdateMode ?? false
      reportData.environments = parsed.environments ?? {}
    }
  } catch {
    console.log('No report.json found, using empty state')
  }
}

export async function resolveReportPath(reportPath: string): Promise<{ reportFile: string; offlineReportDir: string }> {
  if (await isDirectory(reportPath)) {
    return { reportFile: join(reportPath, 'report.json'), offlineReportDir: reportPath }
  }
  return { reportFile: reportPath, offlineReportDir: dirname(reportPath) }
}
