import { afterEach, describe, expect, test } from 'bun:test'

import { CrvyRprtr } from '../src/reporter'

describe('CrvyRprtr serverUrl resolution', () => {
  const originalEnv = process.env.CRVY_RPRTR_SERVER_URL

  afterEach((): void => {
    if (originalEnv === undefined) {
      delete process.env.CRVY_RPRTR_SERVER_URL
    } else {
      process.env.CRVY_RPRTR_SERVER_URL = originalEnv
    }
  })

  test('uses options.serverUrl when provided (highest priority)', () => {
    process.env.CRVY_RPRTR_SERVER_URL = 'ws://from-env:9999'
    const reporter = new CrvyRprtr({ serverUrl: 'ws://from-options:1234' })
    expect(reporter['serverUrl']).toBe('ws://from-options:1234')
  })

  test('falls back to CRVY_RPRTR_SERVER_URL env when options.serverUrl is absent', () => {
    process.env.CRVY_RPRTR_SERVER_URL = 'ws://from-env:9999'
    const reporter = new CrvyRprtr({})
    expect(reporter['serverUrl']).toBe('ws://from-env:9999')
  })

  test('falls back to ws://localhost:3000 default when neither options nor env is set', () => {
    delete process.env.CRVY_RPRTR_SERVER_URL
    const reporter = new CrvyRprtr({})
    expect(reporter['serverUrl']).toBe('ws://localhost:3000')
  })
})
