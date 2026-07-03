/**
 * Graceful shutdown handler for process signals (SIGINT/SIGTERM).
 *
 * On the first signal: flushes the report (via `close`) so the latest in-memory
 * state lands on disk, then exits. This is the key path that prevents data loss
 * when the user Ctrl+Cs the reporter server while a run is in progress or a
 * debounced save is pending.
 *
 * On a second signal: exits immediately so a stuck flush can always be
 * force-killed by the user.
 */
export interface ShutdownDeps {
  close: () => Promise<void>
  exit: (code?: number) => void
}

const EXIT_CODES: Record<string, number> = {
  SIGINT: 130,
  SIGTERM: 143,
  SIGHUP: 129,
}

export function createSignalShutdown(deps: ShutdownDeps): (signal: NodeJS.Signals) => Promise<void> {
  let shuttingDown = false

  return async function shutdown(signal: NodeJS.Signals): Promise<void> {
    if (shuttingDown) {
      deps.exit(EXIT_CODES[signal] ?? 1)
      return
    }
    shuttingDown = true
    try {
      await deps.close()
    } catch {
      // Best-effort: never block exit on a flush error.
    }
    deps.exit(EXIT_CODES[signal] ?? 1)
  }
}
