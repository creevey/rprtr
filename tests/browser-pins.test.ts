import { describe, expect, test } from 'bun:test'

import {
  BrowserPinSchema,
  evaluateBrowserPinPolicy,
  isVersionPrefix,
  matchesVersionPrefix,
  resolveProjectEnvironment,
  type BrowserManifest,
  type ProjectEnvironment,
} from '../src/browser-pins'

function parsePin(value: unknown): { success: boolean } {
  return { success: BrowserPinSchema.safeParse(value).success }
}

describe('BrowserPinSchema', () => {
  test('accepts a major-only prefix', () => {
    expect(parsePin({ browser: 'chromium', version: '147' })).toEqual({ success: true })
  })

  test('accepts a major-minor prefix', () => {
    expect(parsePin({ browser: 'firefox', version: '148.0' })).toEqual({ success: true })
  })

  test('accepts a full version', () => {
    expect(parsePin({ browser: 'webkit', version: '26.4.1.2' })).toEqual({ success: true })
  })

  test('rejects an empty version', () => {
    expect(parsePin({ browser: 'chromium', version: '' })).toEqual({ success: false })
  })

  test('rejects a non-numeric segment', () => {
    expect(parsePin({ browser: 'chromium', version: '147.x' })).toEqual({ success: false })
    expect(parsePin({ browser: 'chromium', version: '147..0' })).toEqual({ success: false })
  })

  test('rejects a moving tag such as `latest`', () => {
    expect(parsePin({ browser: 'chromium', version: 'latest' })).toEqual({ success: false })
  })

  test('rejects an unknown browser name', () => {
    expect(parsePin({ browser: 'opera', version: '147' })).toEqual({ success: false })
  })

  test('rejects missing fields', () => {
    expect(parsePin({ version: '147' })).toEqual({ success: false })
    expect(parsePin({ browser: 'chromium' })).toEqual({ success: false })
  })
})

describe('isVersionPrefix', () => {
  test('true for numeric dotted segments', () => {
    expect(isVersionPrefix('147')).toBe(true)
    expect(isVersionPrefix('147.0')).toBe(true)
    expect(isVersionPrefix('147.0.7727.15')).toBe(true)
  })

  test('false for empty, non-numeric, or partial segments', () => {
    expect(isVersionPrefix('')).toBe(false)
    expect(isVersionPrefix('latest')).toBe(false)
    expect(isVersionPrefix('147.')).toBe(false)
    expect(isVersionPrefix('.147')).toBe(false)
    expect(isVersionPrefix('147.0-beta')).toBe(false)
  })
})

describe('matchesVersionPrefix', () => {
  test('major-only prefix matches any build of that major', () => {
    expect(matchesVersionPrefix('147', '147.0.7727.15')).toBe(true)
  })

  test('major-minor prefix matches', () => {
    expect(matchesVersionPrefix('147.0', '147.0.7727.15')).toBe(true)
  })

  test('a partial trailing segment does not match', () => {
    expect(matchesVersionPrefix('147.0.77', '147.0.7727.15')).toBe(false)
  })

  test('a different build of the same width does not match', () => {
    expect(matchesVersionPrefix('147', '149.0.7827.55')).toBe(false)
    expect(matchesVersionPrefix('147.1', '147.0.7727.15')).toBe(false)
  })

  test('a full version matches itself', () => {
    expect(matchesVersionPrefix('147.0.7727.15', '147.0.7727.15')).toBe(true)
  })

  test('a longer pin than the build does not match', () => {
    expect(matchesVersionPrefix('147.0.7727.15', '147.0')).toBe(false)
  })

  test('numeric segments compare numerically', () => {
    expect(matchesVersionPrefix('147.00', '147.0.7727.15')).toBe(true)
  })
})

const MANIFEST: BrowserManifest = {
  browsers: [
    { name: 'chromium', revision: '1217', browserVersion: '147.0.7727.15', installByDefault: true },
    { name: 'firefox', revision: '1511', browserVersion: '148.0.2', installByDefault: true },
    {
      name: 'webkit',
      revision: '2272',
      browserVersion: '26.4',
      installByDefault: true,
      revisionOverrides: { 'mac14-arm64': '2251' },
    },
  ],
}

const CHROMIUM_PATH = '/caches/ms-playwright/chromium-1217/chrome-mac/Chromium.app/Contents/MacOS/Chromium'

describe('resolveProjectEnvironment', () => {
  test('resolves the effective build from executablePath plus manifest', () => {
    const environment = resolveProjectEnvironment({
      browser: 'chromium',
      executablePath: CHROMIUM_PATH,
      manifest: MANIFEST,
      playwrightVersion: '1.59.0',
      pin: { browser: 'chromium', version: '147' },
    })

    expect(environment).toEqual({
      playwrightVersion: '1.59.0',
      browser: 'chromium',
      browserVersion: '147.0.7727.15',
      revision: '1217',
      pin: { browser: 'chromium', version: '147' },
      status: 'pinned',
    })
  })

  test('reports drift when the effective build does not match the pin', () => {
    const manifest: BrowserManifest = {
      browsers: [{ name: 'chromium', revision: '1290', browserVersion: '149.0.7827.55', installByDefault: true }],
    }
    const environment = resolveProjectEnvironment({
      browser: 'chromium',
      executablePath: '/caches/ms-playwright/chromium-1290/chrome-mac/Chromium.app/Contents/MacOS/Chromium',
      manifest,
      playwrightVersion: '1.59.0',
      pin: { browser: 'chromium', version: '147' },
    })

    expect(environment.status).toBe('drift')
    expect(environment.browserVersion).toBe('149.0.7827.55')
    expect(environment.revision).toBe('1290')
  })

  test('platform revision override makes the build unverifiable', () => {
    const environment = resolveProjectEnvironment({
      browser: 'webkit',
      executablePath: '/caches/ms-playwright/webkit-2251/pw_run.sh',
      manifest: MANIFEST,
      playwrightVersion: '1.59.0',
      pin: { browser: 'webkit', version: '26' },
    })

    expect(environment.status).toBe('unverifiable')
    expect(environment.browserVersion).toBeNull()
    expect(environment.revision).toBe('2251')
  })

  test('a branded channel project is unverifiable', () => {
    const environment = resolveProjectEnvironment({
      browser: 'chromium',
      executablePath: CHROMIUM_PATH,
      manifest: MANIFEST,
      playwrightVersion: '1.59.0',
      pin: { browser: 'chromium', version: '147' },
      channel: 'chrome',
    })

    expect(environment.status).toBe('unverifiable')
    expect(environment.browserVersion).toBeNull()
  })

  test('an explicit browser executable is unverifiable', () => {
    const environment = resolveProjectEnvironment({
      browser: 'chromium',
      executablePath: CHROMIUM_PATH,
      manifest: MANIFEST,
      playwrightVersion: '1.59.0',
      pin: { browser: 'chromium', version: '147' },
      launchExecutablePath: '/opt/google/chrome/chrome',
    })

    expect(environment.status).toBe('unverifiable')
    expect(environment.browserVersion).toBeNull()
  })

  test('a project without a pin is unpinned', () => {
    const environment = resolveProjectEnvironment({
      browser: 'chromium',
      executablePath: CHROMIUM_PATH,
      manifest: MANIFEST,
      playwrightVersion: '1.59.0',
    })

    expect(environment.status).toBe('unpinned')
    expect(environment.pin).toBeUndefined()
    expect(environment.browserVersion).toBe('147.0.7727.15')
  })

  test('records the docker image when the run is containerized', () => {
    const environment = resolveProjectEnvironment({
      browser: 'chromium',
      executablePath: CHROMIUM_PATH,
      manifest: MANIFEST,
      playwrightVersion: '1.59.0',
      dockerImage: 'mcr.microsoft.com/playwright:v1.59.0-noble',
      pin: { browser: 'chromium', version: '147' },
    })

    expect(environment.dockerImage).toBe('mcr.microsoft.com/playwright:v1.59.0-noble')
  })

  test('parses Windows executable paths', () => {
    const environment = resolveProjectEnvironment({
      browser: 'firefox',
      executablePath: 'C:\\Users\\me\\AppData\\Local\\ms-playwright\\firefox-1511\\firefox\\firefox.exe',
      manifest: MANIFEST,
      playwrightVersion: '1.59.0',
      pin: { browser: 'firefox', version: '148' },
    })

    expect(environment.status).toBe('pinned')
    expect(environment.revision).toBe('1511')
    expect(environment.browserVersion).toBe('148.0.2')
  })

  test('an unknown revision is unverifiable rather than drift', () => {
    const environment = resolveProjectEnvironment({
      browser: 'chromium',
      executablePath: '/caches/ms-playwright/chromium-9999/chrome-mac/Chromium.app/Contents/MacOS/Chromium',
      manifest: MANIFEST,
      playwrightVersion: '1.59.0',
      pin: { browser: 'chromium', version: '147' },
    })

    expect(environment.status).toBe('unverifiable')
  })
})

function driftEnvironment(): ProjectEnvironment {
  return resolveProjectEnvironment({
    browser: 'chromium',
    executablePath: '/caches/ms-playwright/chromium-1290/chrome-mac/Chromium.app/Contents/MacOS/Chromium',
    manifest: { browsers: [{ name: 'chromium', revision: '1290', browserVersion: '149.0.7827.55' }] },
    playwrightVersion: '1.59.0',
    pin: { browser: 'chromium', version: '147' },
  })
}

function pinnedEnvironment(): ProjectEnvironment {
  return resolveProjectEnvironment({
    browser: 'chromium',
    executablePath: CHROMIUM_PATH,
    manifest: MANIFEST,
    playwrightVersion: '1.59.0',
    pin: { browser: 'chromium', version: '147' },
  })
}

function unpinnedEnvironment(): ProjectEnvironment {
  return resolveProjectEnvironment({
    browser: 'chromium',
    executablePath: CHROMIUM_PATH,
    manifest: MANIFEST,
    playwrightVersion: '1.59.0',
  })
}

function unverifiableEnvironment(): ProjectEnvironment {
  return resolveProjectEnvironment({
    browser: 'chromium',
    executablePath: CHROMIUM_PATH,
    manifest: MANIFEST,
    playwrightVersion: '1.59.0',
    channel: 'chrome',
    pin: { browser: 'chromium', version: '147' },
  })
}

describe('evaluateBrowserPinPolicy', () => {
  test('warn policy annotates drift without failing', () => {
    const decision = evaluateBrowserPinPolicy({
      policy: 'warn',
      projectName: 'chromium',
      environment: driftEnvironment(),
    })

    expect(decision.action).toBe('warn')
    expect(decision.action === 'none' ? '' : decision.message).toContain('chromium')
    expect(decision.action === 'none' ? '' : decision.message).toContain('147')
    expect(decision.action === 'none' ? '' : decision.message).toContain('149.0.7827.55')
  })

  test('warn policy is quiet for every non-drift status', () => {
    for (const environment of [pinnedEnvironment(), unpinnedEnvironment(), unverifiableEnvironment()]) {
      expect(evaluateBrowserPinPolicy({ policy: 'warn', projectName: 'chromium', environment })).toEqual({
        action: 'none',
      })
    }
  })

  test('fail policy fails on drift with project, pin, effective build, and remedy', () => {
    const decision = evaluateBrowserPinPolicy({
      policy: 'fail',
      projectName: 'chromium',
      environment: driftEnvironment(),
    })

    expect(decision.action).toBe('fail')
    const message = decision.action === 'none' ? '' : decision.message
    expect(message).toContain('chromium')
    expect(message).toContain('chromium@147')
    expect(message).toContain('149.0.7827.55')
    expect(message).toContain('browsers resolve')
  })

  test('fail policy never fails on pinned, unpinned, or unverifiable statuses', () => {
    for (const environment of [pinnedEnvironment(), unpinnedEnvironment(), unverifiableEnvironment()]) {
      expect(evaluateBrowserPinPolicy({ policy: 'fail', projectName: 'chromium', environment })).toEqual({
        action: 'none',
      })
    }
  })

  test('an explicit remedy overrides the default', () => {
    const decision = evaluateBrowserPinPolicy({
      policy: 'fail',
      projectName: 'chromium',
      environment: driftEnvironment(),
      remedy: 'Use mcr.microsoft.com/playwright:v1.42.0-noble',
    })

    expect(decision.action === 'none' ? '' : decision.message).toContain('mcr.microsoft.com/playwright:v1.42.0-noble')
  })

  test('unknown (legacy artifacts) never warns or fails', () => {
    const environment: ProjectEnvironment = { ...pinnedEnvironment(), status: 'unknown' }
    expect(evaluateBrowserPinPolicy({ policy: 'warn', projectName: 'p', environment })).toEqual({ action: 'none' })
    expect(evaluateBrowserPinPolicy({ policy: 'fail', projectName: 'p', environment })).toEqual({ action: 'none' })
  })
})
