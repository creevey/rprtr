import { rm } from 'fs/promises'

import tailwindcss from '@tailwindcss/postcss'
import { build } from 'esbuild'
import sveltePlugin from 'esbuild-svelte'
import postcss from 'postcss'

// Clean dist/
await rm('./dist', { recursive: true, force: true })

// Build CSS with Tailwind
const inputCss = await Bun.file('./src/client/app.css').text()
const result = await postcss([tailwindcss()]).process(inputCss, {
  from: './src/client/app.css',
  to: './dist/index.css',
})
await Bun.write('./dist/index.css', result.css)

// Build client-side JS (Svelte app)
await build({
  entryPoints: ['./src/index.ts'],
  bundle: true,
  outdir: './dist',
  format: 'esm',
  target: 'es2022',
  plugins: [sveltePlugin({ compilerOptions: { css: 'injected' } })],
})

// Build server-side JS (reporter, server, CLI)
await build({
  entryPoints: ['./src/reporter.ts', './src/server.ts', './src/cli.ts'],
  bundle: true,
  splitting: true,
  outdir: './dist',
  format: 'esm',
  target: 'es2022',
  platform: 'node',
  packages: 'external',
})

// Build CJS versions of server-side entry points (for CJS require() resolution compatibility)
await build({
  entryPoints: ['./src/reporter.ts', './src/server.ts'],
  bundle: true,
  outdir: './dist',
  format: 'cjs',
  target: 'es2022',
  platform: 'node',
  packages: 'external',
  outExtension: { '.js': '.cjs' },
})

// Fix CJS interop issues in esbuild output
// NOTE: These patches rely on `packages: 'external'` above, which ensures only ESM-only
// deps (like p-limit) go through __toESM. Adding CJS deps with require() would break Fix 1.
const cjsFiles = ['./dist/reporter.cjs', './dist/server.cjs']
const patchedFiles = await Promise.all(
  cjsFiles.map(async (file) => {
    let content = await Bun.file(file).text()

    // Fix 1: __toESM - when isNodeMode=1 and mod.__esModule is true, esbuild incorrectly
    // sets default to the whole module object instead of mod.default. This breaks ESM-only
    // packages like p-limit whose default export is a function.
    const fix1Pattern = 'isNodeMode || !mod || !mod.__esModule'
    if (!content.includes(fix1Pattern) && content.includes('__toESM')) {
      throw new Error(`${file}: CJS Fix 1 pattern not found — esbuild output format may have changed`)
    }
    content = content.replace(fix1Pattern, '!mod || !mod.__esModule')

    // Fix 2: import.meta.url is undefined in CJS. esbuild emits `var import_meta = {};`
    // Replace with a polyfill using __filename so fileURLToPath(import_meta.url) works.
    const fix2Pattern = 'var import_meta = {};'
    if (content.includes('fileURLToPath') && !content.includes(fix2Pattern)) {
      throw new Error(`${file}: CJS Fix 2 pattern not found — esbuild output format may have changed`)
    }
    content = content.replace(fix2Pattern, 'var import_meta = { url: require("url").pathToFileURL(__filename).href };')

    return { file, content }
  }),
)
await Promise.all(patchedFiles.map(({ file, content }) => Bun.write(file, content)))

// Generate .d.ts files via tsc.
// Run the tsc.js entry directly under the current runtime instead of `bunx tsc`:
// `bunx` does not exit after tsc completes (hangs even on `bunx tsc --version`),
// which deadlocks `await tsc.exited`. Invoking the tsc binary directly avoids the wrapper.
const tsc = Bun.spawn([process.execPath, 'node_modules/typescript/bin/tsc', '--project', 'tsconfig.build.json'], {
  stdout: 'inherit',
  stderr: 'inherit',
})
const tscExitCode = await tsc.exited
if (tscExitCode !== 0) {
  throw new Error(`tsc exited with code ${tscExitCode}`)
}

// Copy index.html into dist/
await Bun.write('./dist/index.html', Bun.file('./index.html'))
