import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, readdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

const repoRoot = join(import.meta.dir, '..')

let workspace = ''
let tarball = ''

interface RunnerStub {
  /** Bare specifier the fixture depends on, e.g. `@playwright/test`. */
  name: string
  /** Directory name for the stub package inside the workspace. */
  dir: string
  /** Version satisfying the peer range, so npm does not warn. */
  version: string
}

const playwrightStub: RunnerStub = { name: '@playwright/test', dir: 'stub-playwright', version: '1.59.0' }
const vitestStub: RunnerStub = { name: 'vitest', dir: 'stub-vitest', version: '4.1.11' }

async function run(command: string[], cwd: string): Promise<{ exitCode: number; output: string }> {
  const subprocess = Bun.spawn(command, { cwd, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
    subprocess.exited,
  ])
  return { exitCode, output: `${stdout}${stderr}` }
}

async function writeStub(stub: RunnerStub): Promise<void> {
  const dir = join(workspace, stub.dir)
  await Bun.write(
    join(dir, 'package.json'),
    `${JSON.stringify({ name: stub.name, version: stub.version, private: true }, null, 2)}\n`,
  )
}

/**
 * Installs the packed tarball into a throwaway project whose only test runner
 * is `stub`, and returns the top-level package names npm put in the tree.
 *
 * The runner is a local stub rather than the real package: the peer contract is
 * about *what npm decides to add*, and a stub keeps that decision observable
 * without downloading a browser harness.
 */
async function installFixture(stub: RunnerStub): Promise<{ exitCode: number; output: string; installed: string[] }> {
  const fixtureDir = await mkdtemp(join(workspace, 'fixture-'))
  await writeFile(
    join(fixtureDir, 'package.json'),
    `${JSON.stringify(
      {
        name: 'crvy-rprtr-package-surface-fixture',
        private: true,
        type: 'module',
        dependencies: { '@crvy/rprtr': `file:${tarball}`, [stub.name]: `file:${join(workspace, stub.dir)}` },
      },
      null,
      2,
    )}\n`,
  )

  const result = await run(['npm', 'install', '--ignore-scripts', '--no-audit', '--no-fund'], fixtureDir)
  const modulesDir = join(fixtureDir, 'node_modules')
  const entries = result.exitCode === 0 ? await readdir(modulesDir) : []
  const installed: string[] = []
  for (const entry of entries) {
    if (entry.startsWith('.')) continue
    if (entry.startsWith('@')) {
      for (const scoped of await readdir(join(modulesDir, entry))) installed.push(`${entry}/${scoped}`)
      continue
    }
    installed.push(entry)
  }
  return { ...result, installed }
}

beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'crvy-package-surface-'))
  await Promise.all([writeStub(playwrightStub), writeStub(vitestStub)])

  const packed = await run(['npm', 'pack', '--pack-destination', workspace], repoRoot)
  if (packed.exitCode !== 0) throw new Error(`npm pack failed:\n${packed.output}`)
  const packedName = (await readdir(workspace)).find((entry) => entry.endsWith('.tgz'))
  if (packedName === undefined) throw new Error(`npm pack produced no tarball:\n${packed.output}`)
  tarball = join(workspace, packedName)
}, 120_000)

afterAll(async () => {
  if (workspace !== '') await rm(workspace, { recursive: true, force: true })
})

describe('package surface', () => {
  test('a playwright-only consumer does not get vitest', async () => {
    const { exitCode, output, installed } = await installFixture(playwrightStub)
    expect({ exitCode, output }).toMatchObject({ exitCode: 0 })
    expect(installed).toContain('@crvy/rprtr')
    expect(installed.filter((name) => name === 'vitest' || name.startsWith('@vitest/'))).toEqual([])
  }, 180_000)

  test('a vitest-only consumer does not get the playwright test package', async () => {
    const { exitCode, output, installed } = await installFixture(vitestStub)
    expect({ exitCode, output }).toMatchObject({ exitCode: 0 })
    expect(installed).toContain('@crvy/rprtr')
    expect(installed).not.toContain('@playwright/test')
  }, 180_000)
})
