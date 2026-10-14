import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'

import { createDebugLogger, log, logError, resolveDebugSettings } from '../src/debug-log'

function clearDebugEnv(): void {
  delete process.env.DEBUG
  delete process.env.CRVY_RPRTR_DEBUG
}

describe('reporter debug gate', () => {
  const saved = { DEBUG: process.env.DEBUG, CRVY_RPRTR_DEBUG: process.env.CRVY_RPRTR_DEBUG }

  beforeEach(() => {
    clearDebugEnv()
  })

  afterEach(() => {
    clearDebugEnv()
    if (saved.DEBUG !== undefined) process.env.DEBUG = saved.DEBUG
    if (saved.CRVY_RPRTR_DEBUG !== undefined) process.env.CRVY_RPRTR_DEBUG = saved.CRVY_RPRTR_DEBUG
  })

  test('CRVY_RPRTR_DEBUG enables reporter log and logError', () => {
    process.env.CRVY_RPRTR_DEBUG = '1'
    const logSpy = spyOn(console, 'log').mockImplementation(() => {})
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {})
    try {
      log('reporter record')
      logError('reporter error')
      expect(logSpy).toHaveBeenCalledWith('reporter record')
      expect(errorSpy).toHaveBeenCalledWith('reporter error')
    } finally {
      logSpy.mockRestore()
      errorSpy.mockRestore()
    }
  })

  test('the legacy DEBUG alias still enables reporter logging', () => {
    process.env.DEBUG = 'pw:webserver'
    const logSpy = spyOn(console, 'log').mockImplementation(() => {})
    try {
      log('legacy record')
      expect(logSpy).toHaveBeenCalledWith('legacy record')
    } finally {
      logSpy.mockRestore()
    }
  })

  test('the gate is non-empty: empty DEBUG and CRVY_RPRTR_DEBUG stay silent', () => {
    process.env.DEBUG = ''
    process.env.CRVY_RPRTR_DEBUG = ''
    const logSpy = spyOn(console, 'log').mockImplementation(() => {})
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {})
    try {
      log('silent')
      logError('silent')
      expect(logSpy).not.toHaveBeenCalled()
      expect(errorSpy).not.toHaveBeenCalled()
    } finally {
      logSpy.mockRestore()
      errorSpy.mockRestore()
    }
  })

  test('neither variable set keeps reporter logging silent', () => {
    const logSpy = spyOn(console, 'log').mockImplementation(() => {})
    try {
      log('silent')
      expect(logSpy).not.toHaveBeenCalled()
    } finally {
      logSpy.mockRestore()
    }
  })
})

describe('createDebugLogger', () => {
  test('emits through the injected sink when enabled', () => {
    const lines: string[] = []
    const debug = createDebugLogger({ enabled: true, sink: (line): void => void lines.push(line) })

    debug.log('[Test] record')

    expect(debug.enabled).toBe(true)
    expect(lines).toEqual(['[Test] record'])
  })

  test('never touches the sink when disabled', () => {
    const lines: string[] = []
    const debug = createDebugLogger({ enabled: false, sink: (line): void => void lines.push(line) })

    debug.log('[Test] record')

    expect(debug.enabled).toBe(false)
    expect(lines).toEqual([])
  })
})

describe('resolveDebugSettings', () => {
  test('the flag enables debug without any environment variable', () => {
    const lines: string[] = []
    const debug = resolveDebugSettings({ flag: true, env: {}, sink: (line): void => void lines.push(line) })

    expect(debug.enabled).toBe(true)
    debug.log('record')
    expect(lines).toEqual(['record'])
  })

  test('CRVY_RPRTR_DEBUG enables debug without the flag', () => {
    const debug = resolveDebugSettings({ env: { CRVY_RPRTR_DEBUG: '1' }, sink: () => {} })
    expect(debug.enabled).toBe(true)
  })

  test("Playwright's DEBUG does not enable server-side debug", () => {
    const debug = resolveDebugSettings({ env: { DEBUG: 'pw:webserver' }, sink: () => {} })
    expect(debug.enabled).toBe(false)
  })

  test('debug stays off without the flag or the variable', () => {
    const debug = resolveDebugSettings({ env: {}, sink: () => {} })
    expect(debug.enabled).toBe(false)
  })
})
