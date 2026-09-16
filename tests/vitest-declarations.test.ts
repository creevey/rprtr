import { describe, expect, test } from 'bun:test'
import { join } from 'path'

import {
  extractVitestScreenshots,
  extractVitestScreenshotsFromModule,
  loadTestSource,
} from '../src/vitest-declarations'

const PLATFORM = process.platform

interface ExtractionContext {
  readonly projectRoot: string
  readonly referenceDir: string
  readonly testFile: string
  readonly browser: string
}

const context: ExtractionContext = {
  projectRoot: '/proj',
  referenceDir: '__screenshots__',
  testFile: '/proj/tests/hero.test.ts',
  browser: 'chromium',
}

function referencePath(imageName: string): string {
  const testFileDirectory = join(context.projectRoot, 'tests')
  return join(
    testFileDirectory,
    context.referenceDir,
    'hero.test.ts',
    `${imageName}-${context.browser}-${PLATFORM}.png`,
  )
}

describe('extractVitestScreenshots', () => {
  test('extracts a named screenshot with its reference path', () => {
    const source = [
      `import { expect, test } from 'vitest'`,
      `import { page } from 'vitest/browser'`,
      ``,
      `test('renders hero section', async () => {`,
      `  await expect(page.getByTestId('hero')).toMatchScreenshot('hero-section')`,
      `})`,
    ].join('\n')

    expect(extractVitestScreenshots(source, [], 'renders hero section', context)).toEqual([
      {
        declaration: {
          kind: 'named',
          visualName: 'hero-section',
          declaredName: 'hero-section',
          snapshotBaseName: 'hero-section',
          occurrenceIndex: 1,
        },
        imageName: 'hero-section',
        referencePath: referencePath('hero-section'),
      },
    ])
  })

  test('repeated identical named calls share one reference file without occurrence suffix', () => {
    const source = [
      `test('renders twice', async () => {`,
      `  await expect(page.getByTestId('hero')).toMatchScreenshot('dup name')`,
      `  await expect(page.getByTestId('hero')).toMatchScreenshot('dup name')`,
      `})`,
    ].join('\n')

    expect(extractVitestScreenshots(source, [], 'renders twice', context)).toEqual([
      {
        declaration: {
          kind: 'named',
          visualName: 'dup-name',
          declaredName: 'dup name',
          snapshotBaseName: 'dup-name',
          occurrenceIndex: 1,
        },
        imageName: 'dup-name',
        referencePath: referencePath('dup-name'),
      },
    ])
  })

  test('repeated unnamed calls get occurrence suffixes from vitest counter', () => {
    const source = [
      `test('unnamed calls', async () => {`,
      `  await expect(page.getByTestId('hero')).toMatchScreenshot()`,
      `  await expect(page.getByTestId('hero')).toMatchScreenshot()`,
      `})`,
    ].join('\n')

    expect(extractVitestScreenshots(source, [], 'unnamed calls', context)).toEqual([
      {
        declaration: { kind: 'unnamed', visualName: 'unnamed-calls-1', occurrenceIndex: 1 },
        imageName: 'unnamed-calls-1',
        referencePath: referencePath('unnamed-calls-1'),
      },
      {
        declaration: { kind: 'unnamed', visualName: 'unnamed-calls-2', occurrenceIndex: 2 },
        imageName: 'unnamed-calls-2',
        referencePath: referencePath('unnamed-calls-2'),
      },
    ])
  })

  test('an unnamed call after a named call still consumes a counter slot', () => {
    const source = [
      `test('mixed calls', async () => {`,
      `  await expect(page.getByTestId('hero')).toMatchScreenshot('named-shot')`,
      `  await expect(page.getByTestId('hero')).toMatchScreenshot()`,
      `})`,
    ].join('\n')

    expect(extractVitestScreenshots(source, [], 'mixed calls', context)).toEqual([
      {
        declaration: {
          kind: 'named',
          visualName: 'named-shot',
          declaredName: 'named-shot',
          snapshotBaseName: 'named-shot',
          occurrenceIndex: 1,
        },
        imageName: 'named-shot',
        referencePath: referencePath('named-shot'),
      },
      {
        declaration: { kind: 'unnamed', visualName: 'mixed-calls-2', occurrenceIndex: 2 },
        imageName: 'mixed-calls-2',
        referencePath: referencePath('mixed-calls-2'),
      },
    ])
  })

  test('path-like names split on slashes and sanitize each segment', () => {
    const source = [
      `test('path like name', async () => {`,
      `  await expect(page.getByTestId('hero')).toMatchScreenshot('nested/dir with spaces/a~b!')`,
      `})`,
    ].join('\n')

    expect(extractVitestScreenshots(source, [], 'path like name', context)).toEqual([
      {
        declaration: {
          kind: 'named',
          visualName: 'nested/dir-with-spaces/ab',
          declaredName: 'nested/dir with spaces/a~b!',
          snapshotBaseName: 'nested/dir-with-spaces/ab',
          occurrenceIndex: 1,
        },
        imageName: 'nested/dir-with-spaces/ab',
        referencePath: join(
          context.projectRoot,
          'tests',
          context.referenceDir,
          'hero.test.ts',
          'nested',
          'dir-with-spaces',
          `ab-${context.browser}-${PLATFORM}.png`,
        ),
      },
    ])
  })

  test('a supported file extension is stripped from the name', () => {
    const source = [
      `test('extension name', async () => {`,
      `  await expect(page.getByTestId('hero')).toMatchScreenshot('hero-section.png')`,
      `})`,
    ].join('\n')

    expect(extractVitestScreenshots(source, [], 'extension name', context)).toEqual([
      {
        declaration: {
          kind: 'named',
          visualName: 'hero-section',
          declaredName: 'hero-section.png',
          snapshotBaseName: 'hero-section',
          occurrenceIndex: 1,
        },
        imageName: 'hero-section',
        referencePath: referencePath('hero-section'),
      },
    ])
  })

  test('attributes calls through nested suites using the vitest full name', () => {
    const source = [
      `describe('outer', () => {`,
      `  describe('inner', () => {`,
      `    test('deep visual', async () => {`,
      `      await expect(page.getByTestId('hero')).toMatchScreenshot()`,
      `    })`,
      `  })`,
      `  test('shallow visual', async () => {`,
      `    await expect(page.getByTestId('hero')).toMatchScreenshot()`,
      `  })`,
      `})`,
    ].join('\n')

    expect(extractVitestScreenshots(source, ['outer', 'inner'], 'deep visual', context)).toEqual([
      {
        declaration: { kind: 'unnamed', visualName: 'outer-inner-deep-visual-1', occurrenceIndex: 1 },
        imageName: 'outer-inner-deep-visual-1',
        referencePath: referencePath('outer-inner-deep-visual-1'),
      },
    ])
    expect(extractVitestScreenshots(source, ['outer'], 'shallow visual', context)).toEqual([
      {
        declaration: { kind: 'unnamed', visualName: 'outer-shallow-visual-1', occurrenceIndex: 1 },
        imageName: 'outer-shallow-visual-1',
        referencePath: referencePath('outer-shallow-visual-1'),
      },
    ])
  })

  test('a same-titled test in another suite does not match', () => {
    const source = [
      `describe('suite a', () => {`,
      `  test('renders', async () => {`,
      `    await expect(page.getByTestId('hero')).toMatchScreenshot('from-a')`,
      `  })`,
      `})`,
      `describe('suite b', () => {`,
      `  test('renders', async () => {`,
      `    await expect(page.getByTestId('hero')).toMatchScreenshot('from-b')`,
      `  })`,
      `})`,
    ].join('\n')

    expect(extractVitestScreenshots(source, ['suite b'], 'renders', context)).toEqual([
      {
        declaration: {
          kind: 'named',
          visualName: 'from-b',
          declaredName: 'from-b',
          snapshotBaseName: 'from-b',
          occurrenceIndex: 1,
        },
        imageName: 'from-b',
        referencePath: referencePath('from-b'),
      },
    ])
  })

  test('test modifiers and options arguments still attribute calls', () => {
    const source = [
      `test.only('only run', { timeout: 5000 }, async () => {`,
      `  await expect(page.getByTestId('hero')).toMatchScreenshot('only-shot')`,
      `})`,
      `it.skip('skipped run', async () => {`,
      `  await expect(page.getByTestId('hero')).toMatchScreenshot('skipped-shot')`,
      `})`,
    ].join('\n')

    expect(extractVitestScreenshots(source, [], 'only run', context)).toEqual([
      {
        declaration: {
          kind: 'named',
          visualName: 'only-shot',
          declaredName: 'only-shot',
          snapshotBaseName: 'only-shot',
          occurrenceIndex: 1,
        },
        imageName: 'only-shot',
        referencePath: referencePath('only-shot'),
      },
    ])
    expect(extractVitestScreenshots(source, [], 'skipped run', context)).toEqual([
      {
        declaration: {
          kind: 'named',
          visualName: 'skipped-shot',
          declaredName: 'skipped-shot',
          snapshotBaseName: 'skipped-shot',
          occurrenceIndex: 1,
        },
        imageName: 'skipped-shot',
        referencePath: referencePath('skipped-shot'),
      },
    ])
  })

  test('non-literal arguments degrade to no declaration', () => {
    const source = [
      `const dynamicName = 'computed'`,
      `test('variable name', async () => {`,
      `  await expect(page.getByTestId('hero')).toMatchScreenshot(dynamicName)`,
      `})`,
      `test('template name', async () => {`,
      `  await expect(page.getByTestId('hero')).toMatchScreenshot(\`shot-\${dynamicName}\`)`,
      `})`,
      `test('object options', async () => {`,
      `  await expect(page.getByTestId('hero')).toMatchScreenshot({ mask: [page.locator('x')] })`,
      `})`,
      `test('no literal call', async () => {`,
      `  await expect.element(page.getByTestId('hero')).toBeVisible()`,
      `})`,
    ].join('\n')

    expect(extractVitestScreenshots(source, [], 'variable name', context)).toEqual([])
    expect(extractVitestScreenshots(source, [], 'template name', context)).toEqual([])
    expect(extractVitestScreenshots(source, [], 'object options', context)).toEqual([])
    expect(extractVitestScreenshots(source, [], 'no literal call', context)).toEqual([])
  })

  test('unattributable titles keep failure-only behavior', () => {
    const source = [
      `test.each([[1]])('case %i', async () => {`,
      `  await expect(page.getByTestId('hero')).toMatchScreenshot('each-shot')`,
      `})`,
      `test('known visual', async () => {`,
      `  await expect(page.getByTestId('hero')).toMatchScreenshot('known-shot')`,
      `})`,
    ].join('\n')

    expect(extractVitestScreenshots(source, [], 'case 1', context)).toEqual([])
    expect(extractVitestScreenshots(source, [], 'known visual', context)).toEqual([
      {
        declaration: {
          kind: 'named',
          visualName: 'known-shot',
          declaredName: 'known-shot',
          snapshotBaseName: 'known-shot',
          occurrenceIndex: 1,
        },
        imageName: 'known-shot',
        referencePath: referencePath('known-shot'),
      },
    ])
  })

  test('calls outside test bodies and inside comments or strings are ignored', () => {
    const source = [
      `// await expect(page.getByTestId('hero')).toMatchScreenshot('commented')`,
      `const sample = "toMatchScreenshot('in-string')"`,
      `await expect(page.getByTestId('hero')).toMatchScreenshot('module-scope')`,
      `test('real test', async () => {`,
      `  await expect(page.getByTestId('hero')).toMatchScreenshot('real-shot')`,
      `})`,
    ].join('\n')

    expect(extractVitestScreenshots(source, [], 'real test', context)).toEqual([
      {
        declaration: {
          kind: 'named',
          visualName: 'real-shot',
          declaredName: 'real-shot',
          snapshotBaseName: 'real-shot',
          occurrenceIndex: 1,
        },
        imageName: 'real-shot',
        referencePath: referencePath('real-shot'),
      },
    ])
  })

  test('escaped quotes inside the declared name are preserved', () => {
    const source = [
      `test('escaped quotes', async () => {`,
      `  await expect(page.getByTestId('hero')).toMatchScreenshot('it\\'s fine')`,
      `})`,
    ].join('\n')

    expect(extractVitestScreenshots(source, [], 'escaped quotes', context)).toEqual([
      {
        declaration: {
          kind: 'named',
          visualName: `its-fine`,
          declaredName: `it's fine`,
          snapshotBaseName: 'its-fine',
          occurrenceIndex: 1,
        },
        imageName: 'its-fine',
        referencePath: referencePath('its-fine'),
      },
    ])
  })
})

describe('extractVitestScreenshotsFromModule', () => {
  test('reads the module from disk and extracts declarations', () => {
    const modulePath = join(import.meta.dir, 'fixtures', 'vitest-declarations-sample.ts')
    const extracted = extractVitestScreenshotsFromModule(modulePath, [], 'renders hero section', context)
    expect(extracted).toEqual([
      {
        declaration: {
          kind: 'named',
          visualName: 'hero-section',
          declaredName: 'hero-section',
          snapshotBaseName: 'hero-section',
          occurrenceIndex: 1,
        },
        imageName: 'hero-section',
        referencePath: referencePath('hero-section'),
      },
    ])
  })

  test('an unreadable module degrades to no declarations', () => {
    expect(loadTestSource(join(context.projectRoot, 'missing', 'hero.test.ts'))).toBeNull()
    expect(
      extractVitestScreenshotsFromModule(
        join(context.projectRoot, 'missing', 'hero.test.ts'),
        [],
        'renders hero section',
        context,
      ),
    ).toEqual([])
  })
})
