import { describe, expect, test } from 'bun:test'

import { formatEnvironment, formatRecord, redactEnvironment } from '../src/debug-log'

describe('redactEnvironment', () => {
  test('allowlisted names carry their values', () => {
    const entries = redactEnvironment({
      CI: '1',
      DEBUG: 'pw:api',
      NODE_ENV: 'test',
      NODE_OPTIONS: '--max-old-space-size=4096',
      CRVY_RPRTR_SERVER_URL: 'ws://localhost:3000',
    })
    expect(entries).toEqual([
      { name: 'CI', value: '1' },
      { name: 'DEBUG', value: 'pw:api' },
      { name: 'NODE_ENV', value: 'test' },
      { name: 'NODE_OPTIONS', value: '--max-old-space-size=4096' },
      { name: 'CRVY_RPRTR_SERVER_URL', value: 'ws://localhost:3000' },
    ])
  })

  test('non-allowlisted names are recorded without values', () => {
    expect(redactEnvironment({ STUB_ENV: 'sentinel-env-value', PATH: '/usr/bin' })).toEqual([
      { name: 'STUB_ENV' },
      { name: 'PATH' },
    ])
  })

  test('credential-shaped names never carry values, even when the prefix is allowlisted', () => {
    const entries = redactEnvironment({
      GITHUB_TOKEN: 'ghp_sentinel_token',
      NPM_TOKEN: 'npm_sentinel_token',
      MY_SECRET: 'sentinel-secret',
      API_KEY: 'sentinel-key',
      DB_PASSWORD: 'sentinel-password',
      AUTH_HEADER: 'Bearer sentinel-auth',
      CRVY_RPRTR_TOKEN: 'sentinel-crvy-token',
    })
    expect(entries.map((entry) => entry.name)).toEqual([
      'GITHUB_TOKEN',
      'NPM_TOKEN',
      'MY_SECRET',
      'API_KEY',
      'DB_PASSWORD',
      'AUTH_HEADER',
      'CRVY_RPRTR_TOKEN',
    ])
    for (const entry of entries) expect(entry.value).toBeUndefined()
  })

  test('undefined values are skipped', () => {
    expect(redactEnvironment({ PRESENT: '1', ABSENT: undefined })).toEqual([{ name: 'PRESENT' }])
  })

  test('URL userinfo in a recorded value is masked', () => {
    const entries = redactEnvironment({ CRVY_RPRTR_SERVER_URL: 'ws://user:pass@example.test/socket' })
    expect(entries).toEqual([{ name: 'CRVY_RPRTR_SERVER_URL', value: 'ws://***@example.test/socket' }])
  })

  test('token-shaped query parameters in a recorded value are masked', () => {
    const entries = redactEnvironment({
      CRVY_RPRTR_SERVER_URL: 'https://example.test/report?access_token=tok_sentinel&keep=1',
    })
    expect(entries).toEqual([
      { name: 'CRVY_RPRTR_SERVER_URL', value: 'https://example.test/report?access_token=***&keep=1' },
    ])
  })
})

describe('formatEnvironment', () => {
  test('renders NAME=value for allowlisted names and NAME for the rest', () => {
    const rendered = formatEnvironment({
      CI: '1',
      NODE_OPTIONS: '--max-old-space-size=4096',
      GITHUB_TOKEN: 'ghp_sentinel',
      STUB_ENV: 'sentinel-env-value',
    })
    expect(rendered).toBe('CI=1 NODE_OPTIONS=--max-old-space-size=4096 GITHUB_TOKEN STUB_ENV')
    expect(rendered).not.toContain('ghp_sentinel')
    expect(rendered).not.toContain('sentinel-env-value')
  })
})

describe('formatRecord', () => {
  test('renders prefix and key=value pairs in order', () => {
    expect(formatRecord('RunController', { event: 'launch', cmd: 'npx' })).toBe('[RunController] event=launch cmd=npx')
  })

  test('skips undefined fields', () => {
    expect(formatRecord('Docker', { image: 'img:1', platform: undefined })).toBe('[Docker] image=img:1')
  })

  test('quotes values containing whitespace', () => {
    expect(formatRecord('RunController', { args: 'test --config /proj/playwright.config.ts' })).toBe(
      '[RunController] args="test --config /proj/playwright.config.ts"',
    )
  })
})
