import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import { resolvePlaywrightVersion } from '../src/playwright-install'

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
