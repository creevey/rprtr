import { describe, expect, test } from 'bun:test'
import { join } from 'path'

const distDir = join(import.meta.dir, '..', 'dist')
const CJS_BUNDLES = ['reporter.cjs', 'server.cjs'] as const

/**
 * esbuild emits `var import_meta = {};` per bundled module that touches
 * import.meta, numbering the extras (`import_meta2`, …). build.ts rewrites each
 * one to a __filename-derived URL; an unpatched copy hands `undefined` to
 * fileURLToPath/createRequire and only fails once that code path runs.
 */
describe('CJS bundles', () => {
  for (const bundle of CJS_BUNDLES) {
    test(`${bundle} has no unpatched import.meta stub`, async () => {
      const content = await Bun.file(join(distDir, bundle)).text()

      expect(content).not.toMatch(/var import_meta\d* = \{\};/)
      expect(content).not.toMatch(/\bimport_meta\d*\.(?!url\b)\w+/)
    })
  }

  test('the CJS reporter constructs under require()', () => {
    const result = Bun.spawnSync([
      'node',
      '-e',
      `const m = require(${JSON.stringify(join(distDir, 'reporter.cjs'))}); new (m.default ?? m)({})`,
    ])

    expect(result.stderr.toString()).toBe('')
    expect(result.exitCode).toBe(0)
  })
})
