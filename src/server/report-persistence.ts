import { writeJsonFile } from './file-utils.ts'

type TimerHandle = ReturnType<typeof setTimeout>
type SetTimer = (fn: () => void, ms?: number) => TimerHandle
type ClearTimer = (handle: TimerHandle | null) => void

export interface DebouncedSaver {
  /** Schedules a save after the debounce window. Re-arms on each call. */
  schedule(): void
  /** Cancels any pending timer; awaits an in-flight save; saves immediately if dirty. */
  flush(): Promise<void>
  /** Cancels any pending timer and clears the dirty flag without saving. */
  cancel(): void
}

export interface ReportPersistence {
  /** Flushes immediately; used by run-end, approvals, child exit, and signals. */
  saveReport: () => Promise<void>
  /** Debounced; used after frequent in-memory mutations (test-begin/test-end). */
  scheduleReportSave: () => void
  /** Flushes any pending debounced write; used during teardown. */
  dispose: () => Promise<void>
}

export function createDebouncedSaver(
  save: () => Promise<void>,
  delayMs: number,
  setTimeoutFn: SetTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimeoutFn: ClearTimer = (handle) => {
    if (handle !== null) clearTimeout(handle)
  },
): DebouncedSaver {
  let timer: TimerHandle | null = null
  let dirty = false
  let inFlight: Promise<void> | null = null

  const runSave = (): Promise<void> => {
    dirty = false
    inFlight = save()
    return inFlight.finally(() => {
      inFlight = null
    })
  }

  return {
    schedule(): void {
      dirty = true
      if (timer !== null) clearTimeoutFn(timer)
      timer = setTimeoutFn(() => {
        timer = null
        void runSave()
      }, delayMs)
    },
    async flush(): Promise<void> {
      if (timer !== null) {
        clearTimeoutFn(timer)
        timer = null
      }
      if (inFlight !== null) {
        await inFlight
      }
      if (dirty) {
        await runSave()
      }
    },
    cancel(): void {
      if (timer !== null) {
        clearTimeoutFn(timer)
        timer = null
      }
      dirty = false
    },
  }
}

/** Builds the debounced report-persistence facade shared by handlers, the run
 * controller, and shutdown. `scheduleReportSave` coalesces frequent mutations;
 * `saveReport` flushes immediately so an interrupted run (Ctrl+C before run-end,
 * killed child, server restart) still lands its results on disk. */
export function createReportPersistence<T>(reportFile: string, reportData: T): ReportPersistence {
  const reportSaver = createDebouncedSaver(() => writeJsonFile(reportFile, reportData), 250)
  return {
    saveReport: (): Promise<void> => reportSaver.flush(),
    scheduleReportSave: (): void => {
      reportSaver.schedule()
    },
    dispose: (): Promise<void> => reportSaver.flush(),
  }
}
