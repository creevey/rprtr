// Playwright specs run under Node, not Bun, so this uses node:child_process.
import { spawn } from 'child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'fs/promises'
import { join } from 'path'

import { expect, test } from '@playwright/test'

import { rootFontconfigPath } from '../../src/fontconfig'

/**
 * The pin works because a reporter constructor runs strictly before Playwright
 * forks any worker, and each worker snapshots the environment at spawn. That is
 * an internal ordering guarantee, so this runs a real multi-worker `playwright
 * test` and asserts every worker saw the variable: a Playwright upgrade that
 * moves reporter construction after the fork fails here rather than silently
 * un-pinning every consumer.
 *
 * Linux-only, because that is where the pin applies at all.
 */
function run(args: string[], cwd: string): Promise<{ exitCode: number; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('bunx', args, {
      cwd,
      // Playwright refuses to nest runs; the outer run's markers have to go.
      env: Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !key.startsWith('PLAYWRIGHT') && !key.startsWith('PW_')),
      ),
    })
    let output = ''
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()))
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()))
    child.on('error', reject)
    child.on('close', (code) => resolve({ exitCode: code ?? -1, output }))
  })
}

test.describe('reporter font rendering', () => {
  test.skip(process.platform !== 'linux', 'fontconfig drives text rendering on Linux only')

  test('every worker of a real run inherits the pinned fontconfig', async () => {
    const repoRoot = join(import.meta.dirname, '..', '..')
    // Inside the repo so the child project resolves @playwright/test from it.
    const projectDir = await mkdtemp(join(repoRoot, 'tests', 'e2e', '.tmp-font-'))
    const observedDir = join(projectDir, 'observed')

    try {
      await mkdir(observedDir, { recursive: true })
      await writeFile(
        join(projectDir, 'playwright.config.ts'),
        [
          "import { defineConfig } from '@playwright/test'",
          'export default defineConfig({',
          `  testDir: ${JSON.stringify(projectDir)},`,
          "  testMatch: '**/*.probe.ts',",
          '  fullyParallel: true,',
          '  workers: 2,',
          `  reporter: [[${JSON.stringify(join(repoRoot, 'src', 'reporter.ts'))}, { ci: true, offlineReportPath: ${JSON.stringify(join(projectDir, 'report.json'))}, reportHtmlPath: ${JSON.stringify(join(projectDir, 'report.html'))}, screenshotDir: ${JSON.stringify(join(projectDir, 'shots'))} }]],`,
          '})',
          '',
        ].join('\n'),
      )

      // Two files so Playwright actually uses both workers; no browser needed —
      // what is under test is the environment the worker process was forked with.
      for (const name of ['one', 'two']) {
        await writeFile(
          join(projectDir, `${name}.probe.ts`),
          [
            "import { writeFileSync } from 'fs'",
            "import { join } from 'path'",
            "import { test } from '@playwright/test'",
            `test(${JSON.stringify(`probe ${name}`)}, () => {`,
            `  writeFileSync(join(${JSON.stringify(observedDir)}, \`\${process.env.TEST_WORKER_INDEX ?? 'x'}.txt\`), process.env.FONTCONFIG_FILE ?? 'unset')`,
            '})',
            '',
          ].join('\n'),
        )
      }

      const { exitCode, output } = await run(
        ['playwright', 'test', '--config', join(projectDir, 'playwright.config.ts')],
        repoRoot,
      )
      expect(exitCode, `child run failed:\n${output}`).toBe(0)

      const observed = await readdir(observedDir)
      expect(observed.length, 'the run should have used two workers').toBe(2)
      for (const file of observed) {
        expect(await readFile(join(observedDir, file), 'utf8')).toBe(rootFontconfigPath())
      }
    } finally {
      await rm(projectDir, { recursive: true, force: true })
    }
  })
})
