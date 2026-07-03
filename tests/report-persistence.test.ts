import { describe, expect, test } from 'bun:test'

import { createDebouncedSaver } from '../src/server/report-persistence'

type TimerHandle = ReturnType<typeof setTimeout>

interface FakeTimerHandle {
  fireAt: number
  fn: () => void
}

interface FakeTimers {
  now: number
  pending: FakeTimerHandle[]
  setTimeout: (fn: () => void, ms?: number) => TimerHandle
  clearTimeout: (handle: TimerHandle | null) => void
  advance: (ms: number) => void
}

function createTimers(): FakeTimers {
  let now = 0
  const pending: FakeTimerHandle[] = []
  return {
    get now() {
      return now
    },
    set now(value: number) {
      now = value
    },
    pending,
    setTimeout: (fn, ms?): TimerHandle => {
      const handle: FakeTimerHandle = { fireAt: now + (ms ?? 0), fn }
      pending.push(handle)
      return handle as unknown as TimerHandle
    },
    clearTimeout: (handle): void => {
      if (handle === null) return
      const i = pending.indexOf(handle as unknown as FakeTimerHandle)
      if (i >= 0) pending.splice(i, 1)
    },
    advance: (ms): void => {
      now += ms
      for (const t of pending.splice(0)) {
        if (t.fireAt <= now) t.fn()
        else pending.push(t)
      }
    },
  }
}

function resolveSave(): () => Promise<void> {
  return () => Promise.resolve()
}

function recordingSave(saves: number[]): { save: () => Promise<void>; count: () => number } {
  let n = 0
  return {
    save: (): Promise<void> => {
      saves.push(++n)
      return Promise.resolve()
    },
    count: (): number => n,
  }
}

describe('createDebouncedSaver', () => {
  test('schedule() does not save synchronously; saves after the delay', async () => {
    const timers = createTimers()
    const saves: number[] = []
    const recorder = recordingSave(saves)
    const saver = createDebouncedSaver(recorder.save, 250, timers.setTimeout, timers.clearTimeout)

    saver.schedule()
    expect(saves).toEqual([])

    timers.advance(249)
    expect(saves).toEqual([])

    timers.advance(2)
    // The timer callback fires void-wrapped; let the microtask resolve.
    await Promise.resolve()
    expect(saves).toEqual([1])
    expect(recorder.count()).toBe(1)
  })

  test('coalesces repeated schedule() calls into a single save', async () => {
    const timers = createTimers()
    const saves: number[] = []
    const recorder = recordingSave(saves)
    const saver = createDebouncedSaver(recorder.save, 100, timers.setTimeout, timers.clearTimeout)

    saver.schedule()
    timers.advance(40)
    saver.schedule()
    timers.advance(40)
    saver.schedule()
    timers.advance(40)
    expect(saves).toEqual([])

    timers.advance(61)
    await Promise.resolve()
    expect(saves).toEqual([1])
  })

  test('flush() saves immediately when dirty and cancels the pending timer', async () => {
    const timers = createTimers()
    const saves: number[] = []
    const recorder = recordingSave(saves)
    const saver = createDebouncedSaver(recorder.save, 1000, timers.setTimeout, timers.clearTimeout)

    saver.schedule()
    await saver.flush()
    expect(saves).toEqual([1])

    // Advancing past the original delay must NOT trigger a second save.
    timers.advance(2000)
    await Promise.resolve()
    expect(saves).toEqual([1])
  })

  test('flush() is a no-op when nothing is scheduled', async () => {
    const timers = createTimers()
    const saves: number[] = []
    const saver = createDebouncedSaver(resolveSave(), 100, timers.setTimeout, timers.clearTimeout)

    await saver.flush()
    expect(saves).toEqual([])
  })

  test('flush() awaits an in-flight save before deciding to save again', async () => {
    const timers = createTimers()
    let resolveInFlight: () => void
    const inFlight = new Promise<void>((resolve) => {
      resolveInFlight = resolve
    })
    let saveCount = 0
    const saver = createDebouncedSaver(
      async () => {
        saveCount++
        if (saveCount === 1) await inFlight
      },
      50,
      timers.setTimeout,
      timers.clearTimeout,
    )

    saver.schedule()
    timers.advance(51)
    await Promise.resolve()
    // The first save is now in-flight and unresolved.
    expect(saveCount).toBe(1)

    // While in-flight, schedule more mutations and call flush.
    saver.schedule()
    const flushPromise = saver.flush()
    resolveInFlight!()
    await flushPromise
    expect(saveCount).toBe(2)
  })

  test('cancel() drops a pending save without writing', async () => {
    const timers = createTimers()
    const saves: number[] = []
    const noop = (): Promise<void> => {
      saves.push(1)
      return Promise.resolve()
    }
    const saver = createDebouncedSaver(noop, 100, timers.setTimeout, timers.clearTimeout)

    saver.schedule()
    saver.cancel()
    timers.advance(200)
    await Promise.resolve()
    expect(saves).toEqual([])
  })

  test('flush() after cancel() does not write', async () => {
    const timers = createTimers()
    const saves: number[] = []
    const noop = (): Promise<void> => {
      saves.push(1)
      return Promise.resolve()
    }
    const saver = createDebouncedSaver(noop, 100, timers.setTimeout, timers.clearTimeout)

    saver.schedule()
    saver.cancel()
    await saver.flush()
    expect(saves).toEqual([])
  })
})
