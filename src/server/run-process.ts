import { spawn } from 'child_process'

import type { ChildProcessLike, RunControllerDeps, SpawnLike } from './run-controller.ts'

const KNOWN_SIGNALS: Record<string, NodeJS.Signals> = {
  SIGTERM: 'SIGTERM',
  SIGKILL: 'SIGKILL',
}

export function createRealSpawn(): SpawnLike {
  return (cmd, args, opts): ChildProcessLike => {
    const cp = spawn(cmd, args, opts)
    return {
      on: (event, cb) => cp.on(event, cb),
      kill: (signal) => {
        const sig = KNOWN_SIGNALS[signal]
        if (sig !== undefined) cp.kill(sig)
      },
    }
  }
}

export function createRealTimers(): RunControllerDeps['timers'] {
  const pending: NodeJS.Timeout[] = []
  return {
    setTimeout: (fn, ms?): unknown => {
      const id = setTimeout(fn, ms)
      pending.push(id)
      return id
    },
    clearTimeout: (): void => {
      for (const h of pending.splice(0)) clearTimeout(h)
    },
  }
}
