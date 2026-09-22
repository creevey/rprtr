import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import { resolveBrowserExecutablePaths, resolvePlaywrightVersion } from '../src/playwright-install'

const tempDirs: string[] = []

async function fixtureProject(packages: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'crvy-playwright-install-'))
  tempDirs.push(dir)
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'fixture', version: '0.0.0' }))
  for (const [name, version] of Object.entries(packages)) {
    const packageDir = join(dir, 'node_modules', ...name.split('/'))
    await mkdir(packageDir, { recursive: true })
    await writeFile(join(packageDir, 'package.json'), JSON.stringify({ name, version }))
  }
  return dir
}

const BROWSER_PATHS = {
  chromium: '/caches/ms-playwright/chromium-1217/chrome-mac/Chromium',
  firefox: '/caches/ms-playwright/firefox-1511/firefox/firefox',
  webkit: '/caches/ms-playwright/webkit-2272/pw_run.sh',
}

/** Writes a package whose entry point exposes the bundled browser types. */
async function fixtureBrowserPackage(
  dir: string,
  name: string,
  version: string,
  paths: Record<string, string>,
): Promise<void> {
  const packageDir = join(dir, 'node_modules', ...name.split('/'))
  await mkdir(packageDir, { recursive: true })
  await writeFile(join(packageDir, 'package.json'), JSON.stringify({ name, version, main: 'index.js' }))
  const entries = Object.entries(paths).map(
    ([browser, path]) => `  ${browser}: { executablePath: () => ${JSON.stringify(path)} },`,
  )
  await writeFile(join(packageDir, 'index.js'), `module.exports = {\n${entries.join('\n')}\n}\n`)
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('resolvePlaywrightVersion', () => {
  test('resolves the installed playwright version', async () => {
    const dir = await fixtureProject({ playwright: '1.59.0' })
    expect(resolvePlaywrightVersion(dir)).toBe('1.59.0')
  })

  test('prefers playwright over @playwright/test when both are installed', async () => {
    const dir = await fixtureProject({ playwright: '1.59.0', '@playwright/test': '1.58.0' })
    expect(resolvePlaywrightVersion(dir)).toBe('1.59.0')
  })

  test('falls back to @playwright/test when playwright is not installed', async () => {
    const dir = await fixtureProject({ '@playwright/test': '1.58.0' })
    expect(resolvePlaywrightVersion(dir)).toBe('1.58.0')
  })

  test('falls back to @playwright/test when playwright has no readable manifest', async () => {
    const dir = await fixtureProject({ '@playwright/test': '1.58.0' })
    const playwrightDir = join(dir, 'node_modules', 'playwright')
    await mkdir(playwrightDir, { recursive: true })
    await writeFile(join(playwrightDir, 'package.json'), 'not json')
    expect(resolvePlaywrightVersion(dir)).toBe('1.58.0')
  })

  test('returns null when neither package resolves', async () => {
    const dir = await fixtureProject({ vitest: '4.1.0' })
    expect(resolvePlaywrightVersion(dir)).toBeNull()
  })
})

describe('resolveBrowserExecutablePaths', () => {
  test('resolves every bundled browser from a playwright-only install', async () => {
    const dir = await fixtureProject({})
    await fixtureBrowserPackage(dir, 'playwright', '1.59.0', BROWSER_PATHS)

    expect(resolveBrowserExecutablePaths(dir)).toEqual(BROWSER_PATHS)
  })

  test('prefers the project playwright over @playwright/test', async () => {
    const dir = await fixtureProject({})
    await fixtureBrowserPackage(dir, 'playwright', '1.59.0', BROWSER_PATHS)
    await fixtureBrowserPackage(dir, '@playwright/test', '1.58.0', {
      chromium: '/caches/ms-playwright/chromium-1290/chrome-mac/Chromium',
    })

    expect(resolveBrowserExecutablePaths(dir)?.chromium).toBe(BROWSER_PATHS.chromium)
  })

  test('null when a package does not expose every browser', async () => {
    const dir = await fixtureProject({})
    await fixtureBrowserPackage(dir, 'playwright', '1.59.0', { chromium: BROWSER_PATHS.chromium })

    expect(resolveBrowserExecutablePaths(dir)).toBeNull()
  })

  test('null when neither package resolves', async () => {
    const dir = await fixtureProject({ vitest: '4.1.0' })

    expect(resolveBrowserExecutablePaths(dir)).toBeNull()
  })
})
