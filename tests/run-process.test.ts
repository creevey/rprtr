import { describe, expect, test } from 'bun:test'

import { createRealSpawn } from '../src/server/run-process'

interface Settle {
  code: number | null
  signal?: string | null
}

function spawnScript(script: string): { settle: Promise<Settle>; kill: (signal: string) => void } {
  const child = createRealSpawn()(process.execPath, ['-e', script], { stdio: 'ignore' })
  const settle = new Promise<Settle>((resolve) => {
    child.on('exit', (code, signal) => {
      resolve({ code, signal })
    })
  })
  return { settle, kill: (signal): void => child.kill(signal) }
}

describe('createRealSpawn', () => {
  test('forwards the exit code of a normal exit', async () => {
    const { settle } = spawnScript('process.exit(3)')
    expect(await settle).toEqual({ code: 3, signal: null })
  })

  test('forwards the terminating signal instead of a code', async () => {
    const { settle, kill } = spawnScript('setInterval(() => {}, 1000)')
    kill('SIGKILL')
    expect(await settle).toEqual({ code: null, signal: 'SIGKILL' })
  })
})
