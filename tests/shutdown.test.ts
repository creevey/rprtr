import { describe, expect, test } from 'bun:test'

import { createSignalShutdown } from '../src/server/shutdown'

interface Calls {
  closeCalls: number
  exitCodes: number[]
}

function setup(): { handler: ReturnType<typeof createSignalShutdown>; calls: Calls } {
  const calls: Calls = { closeCalls: 0, exitCodes: [] }
  const handler = createSignalShutdown({
    close: (): Promise<void> => {
      calls.closeCalls++
      return Promise.resolve()
    },
    exit: (code?: number): void => {
      calls.exitCodes.push(code ?? 0)
    },
  })
  return { handler, calls }
}

describe('createSignalShutdown', () => {
  test('first signal: awaits close then exits with SIGINT code', async () => {
    const { handler, calls } = setup()
    await handler('SIGINT')
    expect(calls.closeCalls).toBe(1)
    expect(calls.exitCodes).toEqual([130])
  })

  test('first signal SIGTERM exits with code 143', async () => {
    const { handler, calls } = setup()
    await handler('SIGTERM')
    expect(calls.closeCalls).toBe(1)
    expect(calls.exitCodes).toEqual([143])
  })

  test('a close error is swallowed so shutdown still exits', async () => {
    const calls: Calls = { closeCalls: 0, exitCodes: [] }
    const handler = createSignalShutdown({
      close: (): Promise<void> => {
        calls.closeCalls++
        return Promise.reject(new Error('flush failed'))
      },
      exit: (code?: number): void => {
        calls.exitCodes.push(code ?? 0)
      },
    })
    await handler('SIGINT')
    expect(calls.closeCalls).toBe(1)
    expect(calls.exitCodes).toEqual([130])
  })

  test('second signal exits immediately without awaiting close', async () => {
    const { handler, calls } = setup()
    await handler('SIGINT')
    calls.closeCalls = 0
    await handler('SIGINT')
    expect(calls.closeCalls).toBe(0)
    expect(calls.exitCodes).toHaveLength(2)
  })

  test('does not interleave: a second signal during an in-flight close exits at once', async () => {
    const calls: Calls = { closeCalls: 0, exitCodes: [] }
    let resolveClose: () => void
    const closeStarted = new Promise<void>((resolve) => {
      resolveClose = resolve
    })
    const handler = createSignalShutdown({
      close: async (): Promise<void> => {
        calls.closeCalls++
        await closeStarted
      },
      exit: (code?: number): void => {
        calls.exitCodes.push(code ?? 0)
      },
    })

    const first = handler('SIGINT')
    // While the first close is still pending, a second signal arrives.
    await handler('SIGINT')
    expect(calls.exitCodes).toEqual([130])
    expect(calls.closeCalls).toBe(1)

    // Let the first close finish; it should then exit too.
    resolveClose!()
    await first
    expect(calls.exitCodes).toEqual([130, 130])
  })
})
