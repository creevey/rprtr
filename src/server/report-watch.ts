import { readdir, stat } from 'fs/promises'
import { join } from 'path'

import { isDirectory } from './file-utils.ts'

const OFFLINE_REPORT_FILE_PATTERN = /^crvy-rprtr(?:-\d+)?\.json$/

export function createDebouncedRefresh(reload: () => Promise<void>, delayMs = 50): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null

  return (): void => {
    if (timer !== null) {
      clearTimeout(timer)
    }

    timer = setTimeout(() => {
      timer = null
      void reload()
    }, delayMs)
  }
}

interface ReportWatchOptions {
  offlineReportDir: string
  screenshotDir: string
  scheduleRefresh: () => void
}

function isFileNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

async function describeFile(filePath: string, label: string): Promise<string | null> {
  try {
    const fileStats = await stat(filePath)
    return `${label}:${fileStats.size}:${fileStats.mtimeMs}`
  } catch (error: unknown) {
    if (isFileNotFound(error)) {
      return null
    }

    throw error
  }
}

async function createOfflineFingerprint(offlineReportDir: string): Promise<string> {
  if (!(await isDirectory(offlineReportDir))) {
    return 'offline:missing'
  }

  try {
    const entries = await readdir(offlineReportDir, { withFileTypes: true })
    const relevantEntries = entries
      .filter(
        (entry) => entry.isFile() && (entry.name === 'report.json' || OFFLINE_REPORT_FILE_PATTERN.test(entry.name)),
      )
      .sort((left, right) => left.name.localeCompare(right.name))

    const parts = await Promise.all(
      relevantEntries.map((entry) => describeFile(join(offlineReportDir, entry.name), entry.name)),
    )

    return `offline:${parts.filter((part): part is string => part !== null).join('|')}`
  } catch (error: unknown) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    console.warn(`[Server] Unable to scan ${offlineReportDir}: ${errorMsg}`)
    return 'offline:error'
  }
}

async function createScreenshotFingerprint(screenshotDir: string, relativePath = ''): Promise<string[]> {
  const directoryPath = relativePath === '' ? screenshotDir : join(screenshotDir, relativePath)
  if (!(await isDirectory(directoryPath))) {
    return relativePath === '' ? ['screenshots:missing'] : []
  }

  try {
    const entries = await readdir(directoryPath, { withFileTypes: true })
    const parts = await Promise.all(
      entries
        .sort((left, right) => left.name.localeCompare(right.name))
        .map((entry) => {
          const entryRelativePath = relativePath === '' ? entry.name : join(relativePath, entry.name)
          if (entry.isDirectory()) {
            return createScreenshotFingerprint(screenshotDir, entryRelativePath)
          }

          return describeFile(join(screenshotDir, entryRelativePath), entryRelativePath)
        }),
    )

    return parts.flat().filter((part): part is string => part !== null)
  } catch (error: unknown) {
    if (isFileNotFound(error)) {
      return relativePath === '' ? ['screenshots:missing'] : []
    }

    const errorMsg = error instanceof Error ? error.message : String(error)
    console.warn(`[Server] Unable to scan ${directoryPath}: ${errorMsg}`)
    return relativePath === '' ? ['screenshots:error'] : []
  }
}

async function createArtifactsFingerprint(options: ReportWatchOptions): Promise<string> {
  const [offlineFingerprint, screenshotFingerprint] = await Promise.all([
    createOfflineFingerprint(options.offlineReportDir),
    createScreenshotFingerprint(options.screenshotDir),
  ])

  return `${offlineFingerprint}::${screenshotFingerprint.join('|')}`
}

export async function watchReportArtifacts(options: ReportWatchOptions): Promise<() => void> {
  let fingerprint = await createArtifactsFingerprint(options)
  let isPolling = false

  // Bun's fs.watch is not reliable in this environment, so poll a narrow artifact fingerprint instead.
  const interval = setInterval(() => {
    if (isPolling) {
      return
    }

    isPolling = true
    void createArtifactsFingerprint(options)
      .then((nextFingerprint) => {
        if (nextFingerprint === fingerprint) {
          return
        }

        fingerprint = nextFingerprint
        options.scheduleRefresh()
      })
      .catch((error: unknown) => {
        const errorMsg = error instanceof Error ? error.message : String(error)
        console.warn(`[Server] Artifact refresh poll failed: ${errorMsg}`)
      })
      .finally(() => {
        isPolling = false
      })
  }, 100)

  return (): void => {
    clearInterval(interval)
  }
}
