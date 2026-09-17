import { describe, expect, test } from 'bun:test'

import {
  describeEnvironment,
  environmentBadgeEntries,
  environmentForTest,
  isDriftedTest,
  isVisiblePinStatus,
  pinStatusLabel,
  testPinStatus,
} from '../src/client/helpers/browser-pins'
import type { ProjectEnvironment, RunEnvironments } from '../src/schemas'

const PINNED: ProjectEnvironment = {
  playwrightVersion: '1.59.0',
  browser: 'chromium',
  browserVersion: '147.0.7727.15',
  revision: '1217',
  pin: { browser: 'chromium', version: '147' },
  status: 'pinned',
}

const DRIFT: ProjectEnvironment = {
  playwrightVersion: '1.59.0',
  browser: 'chromium',
  browserVersion: '149.0.7827.55',
  revision: '1290',
  pin: { browser: 'chromium', version: '147' },
  status: 'drift',
}

const ENVIRONMENTS: RunEnvironments = {
  chromium: DRIFT,
  firefox: { ...PINNED, browser: 'firefox', browserVersion: '148.0.2', revision: '1511' },
}

describe('pin status labels', () => {
  test('labels every status', () => {
    expect(pinStatusLabel('pinned')).toBe('Pinned')
    expect(pinStatusLabel('drift')).toBe('Drift')
    expect(pinStatusLabel('unpinned')).toBe('Unpinned')
    expect(pinStatusLabel('unverifiable')).toBe('Unverifiable')
    expect(pinStatusLabel('unknown')).toBe('Unknown')
  })

  test('only pinned, drift, and unverifiable are worth a badge', () => {
    expect(isVisiblePinStatus('pinned')).toBe(true)
    expect(isVisiblePinStatus('drift')).toBe(true)
    expect(isVisiblePinStatus('unverifiable')).toBe(true)
    expect(isVisiblePinStatus('unpinned')).toBe(false)
    expect(isVisiblePinStatus('unknown')).toBe(false)
  })

  test('badge entries skip unpinned and unknown environments', () => {
    const entries = environmentBadgeEntries({
      chromium: PINNED,
      firefox: { ...PINNED, browser: 'firefox', status: 'unpinned' },
      webkit: { ...PINNED, browser: 'webkit', status: 'unknown' },
    })

    expect(entries.map(([name]) => name)).toEqual(['chromium'])
  })

  test('missing environments produce no badge entries', () => {
    expect(environmentBadgeEntries(undefined)).toEqual([])
  })
})

describe('test pin lookups', () => {
  test('resolves the environment by project name with a browser fallback', () => {
    expect(environmentForTest(ENVIRONMENTS, { projectName: 'chromium', browser: 'chromium' })).toBe(DRIFT)
    expect(environmentForTest(ENVIRONMENTS, { projectName: '', browser: 'firefox' })).toBe(ENVIRONMENTS.firefox)
    expect(environmentForTest(undefined, { projectName: 'chromium', browser: 'chromium' })).toBeUndefined()
  })

  test('status is drift for drifted projects and unknown otherwise', () => {
    expect(testPinStatus(ENVIRONMENTS, { projectName: 'chromium', browser: 'chromium' })).toBe('drift')
    expect(testPinStatus(ENVIRONMENTS, { projectName: 'firefox', browser: 'firefox' })).toBe('pinned')
    expect(testPinStatus(ENVIRONMENTS, { projectName: 'webkit', browser: 'webkit' })).toBe('unknown')
    expect(isDriftedTest(ENVIRONMENTS, { projectName: 'chromium', browser: 'chromium' })).toBe(true)
    expect(isDriftedTest(ENVIRONMENTS, { projectName: 'firefox', browser: 'firefox' })).toBe(false)
  })

  test('legacy data without environments is unknown, never drift', () => {
    expect(testPinStatus(undefined, { projectName: 'chromium', browser: 'chromium' })).toBe('unknown')
    expect(isDriftedTest(undefined, { projectName: 'chromium', browser: 'chromium' })).toBe(false)
  })
})

describe('describeEnvironment', () => {
  test('names the build, revision, Playwright version, and pin', () => {
    const description = describeEnvironment('chromium', PINNED)

    expect(description).toContain('chromium 147.0.7727.15')
    expect(description).toContain('revision 1217')
    expect(description).toContain('Playwright 1.59.0')
    expect(description).toContain('pins chromium@147')
  })

  test('names the docker image when the run is containerized', () => {
    const description = describeEnvironment('chromium', {
      ...PINNED,
      dockerImage: 'mcr.microsoft.com/playwright:v1.59.0-noble',
    })

    expect(description).toContain('mcr.microsoft.com/playwright:v1.59.0-noble')
  })

  test('explains unverifiable environments instead of naming a build', () => {
    const description = describeEnvironment('chrome-channel', {
      ...PINNED,
      browserVersion: null,
      revision: null,
      status: 'unverifiable',
    })

    expect(description.toLowerCase()).toContain('unverifiable')
  })
})
