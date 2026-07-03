import { createServerApp, type ServerOptions } from './server/app.ts'
import { startBunServer } from './server/bun-adapter.ts'
import { startNodeServer } from './server/node-adapter.ts'
import { createSignalShutdown } from './server/shutdown.ts'

export type { ServerOptions } from './server/app.ts'

export async function startServer(options: ServerOptions = {}): Promise<void> {
  const app = await createServerApp(options)

  // Flush the report and dispose the run controller on SIGINT/SIGTERM so an
  // interrupted server restart does not lose in-memory test results. A second
  // signal force-exits.
  const shutdown = createSignalShutdown({ close: () => app.close(), exit: (code) => process.exit(code) })
  const onSignal = (signal: NodeJS.Signals): void => {
    void shutdown(signal)
  }
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)

  if (typeof Bun !== 'undefined' && typeof Bun.serve === 'function') {
    startBunServer(app)
    return
  }

  await startNodeServer(app)
}
