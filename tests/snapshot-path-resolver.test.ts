import { describe, expect, test } from 'bun:test'
import { basename, join } from 'path'

import { resolveBaselineTargets, sanitizeForFilePath } from '../src/snapshot-path-resolver'

const TEST_DIR = join(process.cwd(), 'tests')
const TEST_FILE = join(TEST_DIR, 'example.spec.ts')
const REPORTER_TITLE_PATH = ['', 'chromium', 'example.spec.ts', 'Suite', 'visual pass']

describe('sanitizeForFilePath', () => {
  test('collapses consecutive unsafe characters into a single dash', () => {
    expect(sanitizeForFilePath('header::mobile')).toBe('header-mobile')
  })
})

describe('resolveBaselineTargets', () => {
  test('resolves a named screenshot with the default Playwright screenshot layout', () => {
    const targets = resolveBaselineTargets({
      testFile: TEST_FILE,
      reporterTitlePath: REPORTER_TITLE_PATH,
      declarations: [
        {
          visualName: 'header',
          kind: 'named',
          declaredName: 'header',
          occurrenceIndex: 1,
        },
      ],
      config: {
        configDir: process.cwd(),
        testDir: TEST_DIR,
        snapshotDir: TEST_DIR,
        projectName: 'chromium',
        snapshotSuffix: process.platform,
      },
    })

    expect(targets).toEqual([
      {
        visualName: 'header',
        attachmentBaseName: 'header',
        artifactBaseName: 'header',
        snapshotPath: join(TEST_DIR, 'example.spec.ts-snapshots', `header-chromium-${process.platform}.png`),
      },
    ])
  })

  test('resolves a named screenshot with an explicit toHaveScreenshot path template', () => {
    const targets = resolveBaselineTargets({
      testFile: TEST_FILE,
      reporterTitlePath: REPORTER_TITLE_PATH,
      declarations: [
        {
          visualName: 'header',
          kind: 'named',
          declaredName: 'header',
          occurrenceIndex: 1,
        },
      ],
      config: {
        configDir: process.cwd(),
        testDir: TEST_DIR,
        snapshotDir: join(TEST_DIR, 'custom-snapshots'),
        projectName: 'chromium',
        snapshotSuffix: process.platform,
        toHaveScreenshotPathTemplate: '{snapshotDir}/{projectName}/{testFilePath}/{arg}{ext}',
      },
    })

    expect(targets).toEqual([
      {
        visualName: 'header',
        attachmentBaseName: 'header',
        artifactBaseName: 'header',
        snapshotPath: join(TEST_DIR, 'custom-snapshots', 'chromium', 'example.spec.ts', 'header.png'),
      },
    ])
  })

  test('keeps stable visual and attachment names while exposing a filesystem-safe artifact base', () => {
    const targets = resolveBaselineTargets({
      testFile: TEST_FILE,
      reporterTitlePath: REPORTER_TITLE_PATH,
      declarations: [
        {
          visualName: 'header:mobile',
          kind: 'named',
          declaredName: 'header:mobile',
          occurrenceIndex: 1,
        },
      ],
      config: {
        configDir: process.cwd(),
        testDir: TEST_DIR,
        snapshotDir: TEST_DIR,
        projectName: 'chromium',
        snapshotSuffix: process.platform,
      },
    })

    expect(targets).toEqual([
      {
        visualName: 'header:mobile',
        attachmentBaseName: 'header:mobile',
        artifactBaseName: 'header-mobile',
        snapshotPath: join(TEST_DIR, 'example.spec.ts-snapshots', `header-mobile-chromium-${process.platform}.png`),
      },
    ])
  })

  test('uses occurrence indexes to resolve duplicate named screenshots to distinct baselines', () => {
    const targets = resolveBaselineTargets({
      testFile: TEST_FILE,
      reporterTitlePath: REPORTER_TITLE_PATH,
      declarations: [
        {
          visualName: 'header',
          kind: 'named',
          declaredName: 'header',
          occurrenceIndex: 1,
        },
        {
          visualName: 'header-1',
          kind: 'named',
          declaredName: 'header',
          occurrenceIndex: 2,
        },
      ],
      config: {
        configDir: process.cwd(),
        testDir: TEST_DIR,
        snapshotDir: TEST_DIR,
        projectName: 'chromium',
        snapshotSuffix: process.platform,
      },
    })

    expect(targets).toEqual([
      {
        visualName: 'header',
        attachmentBaseName: 'header',
        artifactBaseName: 'header',
        snapshotPath: join(TEST_DIR, 'example.spec.ts-snapshots', `header-chromium-${process.platform}.png`),
      },
      {
        visualName: 'header-1',
        attachmentBaseName: 'header-1',
        artifactBaseName: 'header-1',
        snapshotPath: join(TEST_DIR, 'example.spec.ts-snapshots', `header-1-chromium-${process.platform}.png`),
      },
    ])
  })

  test('resolves an unnamed screenshot using Playwright anonymous naming rules', () => {
    const targets = resolveBaselineTargets({
      testFile: TEST_FILE,
      reporterTitlePath: REPORTER_TITLE_PATH,
      declarations: [
        {
          visualName: '__unnamed-screenshot-1',
          kind: 'unnamed',
          occurrenceIndex: 1,
        },
      ],
      config: {
        configDir: process.cwd(),
        testDir: TEST_DIR,
        snapshotDir: TEST_DIR,
        projectName: 'chromium',
        snapshotSuffix: process.platform,
      },
    } as Parameters<typeof resolveBaselineTargets>[0])

    expect(targets).toEqual([
      {
        visualName: '__unnamed-screenshot-1',
        attachmentBaseName: '__unnamed-screenshot-1',
        artifactBaseName: '-unnamed-screenshot-1',
        snapshotPath: join(
          TEST_DIR,
          'example.spec.ts-snapshots',
          `Suite-visual-pass-1-chromium-${process.platform}.png`,
        ),
      },
    ])
  })

  test('resolves multiple unnamed screenshots in one test using incrementing anonymous indexes', () => {
    const targets = resolveBaselineTargets({
      testFile: TEST_FILE,
      reporterTitlePath: REPORTER_TITLE_PATH,
      declarations: [
        {
          visualName: '__unnamed-screenshot-1',
          kind: 'unnamed',
          occurrenceIndex: 1,
        },
        {
          visualName: '__unnamed-screenshot-2',
          kind: 'unnamed',
          occurrenceIndex: 2,
        },
      ],
      config: {
        configDir: process.cwd(),
        testDir: TEST_DIR,
        snapshotDir: TEST_DIR,
        projectName: 'chromium',
        snapshotSuffix: process.platform,
      },
    } as Parameters<typeof resolveBaselineTargets>[0])

    expect(targets).toEqual([
      {
        visualName: '__unnamed-screenshot-1',
        attachmentBaseName: '__unnamed-screenshot-1',
        artifactBaseName: '-unnamed-screenshot-1',
        snapshotPath: join(
          TEST_DIR,
          'example.spec.ts-snapshots',
          `Suite-visual-pass-1-chromium-${process.platform}.png`,
        ),
      },
      {
        visualName: '__unnamed-screenshot-2',
        attachmentBaseName: '__unnamed-screenshot-2',
        artifactBaseName: '-unnamed-screenshot-2',
        snapshotPath: join(
          TEST_DIR,
          'example.spec.ts-snapshots',
          `Suite-visual-pass-2-chromium-${process.platform}.png`,
        ),
      },
    ])
  })

  test('trims long unnamed screenshot titles with the same hash format Playwright uses', () => {
    const target = resolveBaselineTargets({
      testFile: TEST_FILE,
      reporterTitlePath: [
        '',
        'chromium',
        'example.spec.ts',
        'A suite title that is intentionally very long to exercise trimming',
        'and an equally long test title to force a hashed anonymous screenshot name',
      ],
      declarations: [
        {
          visualName: '__unnamed-screenshot-1',
          kind: 'unnamed',
          occurrenceIndex: 1,
        },
      ],
      config: {
        configDir: process.cwd(),
        testDir: TEST_DIR,
        snapshotDir: TEST_DIR,
        projectName: 'chromium',
        snapshotSuffix: process.platform,
      },
    } as Parameters<typeof resolveBaselineTargets>[0])[0]

    expect(target).toBeDefined()
    expect(basename(target!.snapshotPath)).toMatch(/-[0-9a-f]{5}-/)
    expect(basename(target!.snapshotPath)).toEndWith(`-chromium-${process.platform}.png`)
  })

  test('returns no target for slash-containing names when no existence callback is provided', () => {
    const targets = resolveBaselineTargets({
      testFile: TEST_FILE,
      reporterTitlePath: REPORTER_TITLE_PATH,
      declarations: [
        {
          visualName: 'dir/header',
          kind: 'named',
          declaredName: 'dir/header.png',
          occurrenceIndex: 1,
        },
      ],
      config: {
        configDir: process.cwd(),
        testDir: TEST_DIR,
        snapshotDir: TEST_DIR,
        projectName: 'chromium',
        snapshotSuffix: process.platform,
      },
    })

    expect(targets).toEqual([])
  })

  test('resolves the string-call variant when it is the only existing slash-name candidate', () => {
    const stringVariantPath = join(TEST_DIR, 'example.spec.ts-snapshots', `dir-header-chromium-${process.platform}.png`)

    const targets = resolveBaselineTargets({
      testFile: TEST_FILE,
      reporterTitlePath: REPORTER_TITLE_PATH,
      declarations: [
        {
          visualName: 'dir/header',
          kind: 'named',
          declaredName: 'dir/header.png',
          occurrenceIndex: 1,
        },
      ],
      config: {
        configDir: process.cwd(),
        testDir: TEST_DIR,
        snapshotDir: TEST_DIR,
        projectName: 'chromium',
        snapshotSuffix: process.platform,
      },
      snapshotPathExists: (snapshotPath) => snapshotPath === stringVariantPath,
    } as Parameters<typeof resolveBaselineTargets>[0])

    expect(targets).toEqual([
      {
        visualName: 'dir/header',
        attachmentBaseName: 'dir/header',
        artifactBaseName: 'dir-header',
        snapshotPath: stringVariantPath,
      },
    ])
  })

  test('resolves the array-call variant when it is the only existing slash-name candidate', () => {
    const arrayVariantPath = join(
      TEST_DIR,
      'example.spec.ts-snapshots',
      'dir',
      `header-chromium-${process.platform}.png`,
    )

    const targets = resolveBaselineTargets({
      testFile: TEST_FILE,
      reporterTitlePath: REPORTER_TITLE_PATH,
      declarations: [
        {
          visualName: 'dir/header',
          kind: 'named',
          declaredName: 'dir/header.png',
          occurrenceIndex: 1,
        },
      ],
      config: {
        configDir: process.cwd(),
        testDir: TEST_DIR,
        snapshotDir: TEST_DIR,
        projectName: 'chromium',
        snapshotSuffix: process.platform,
      },
      snapshotPathExists: (snapshotPath) => snapshotPath === arrayVariantPath,
    } as Parameters<typeof resolveBaselineTargets>[0])

    expect(targets).toEqual([
      {
        visualName: 'dir/header',
        attachmentBaseName: 'dir/header',
        artifactBaseName: 'dir-header',
        snapshotPath: arrayVariantPath,
      },
    ])
  })

  test('returns no target for slash-containing names when both slash-name candidates exist', () => {
    const stringVariantPath = join(TEST_DIR, 'example.spec.ts-snapshots', `dir-header-chromium-${process.platform}.png`)
    const arrayVariantPath = join(
      TEST_DIR,
      'example.spec.ts-snapshots',
      'dir',
      `header-chromium-${process.platform}.png`,
    )

    const targets = resolveBaselineTargets({
      testFile: TEST_FILE,
      reporterTitlePath: REPORTER_TITLE_PATH,
      declarations: [
        {
          visualName: 'dir/header',
          kind: 'named',
          declaredName: 'dir/header.png',
          occurrenceIndex: 1,
        },
      ],
      config: {
        configDir: process.cwd(),
        testDir: TEST_DIR,
        snapshotDir: TEST_DIR,
        projectName: 'chromium',
        snapshotSuffix: process.platform,
      },
      snapshotPathExists: (snapshotPath) => snapshotPath === stringVariantPath || snapshotPath === arrayVariantPath,
    } as Parameters<typeof resolveBaselineTargets>[0])

    expect(targets).toEqual([])
  })

  test('preserves the array-call filename when slash-name segments contain unsafe characters', () => {
    const arrayVariantPath = join(
      TEST_DIR,
      'example.spec.ts-snapshots',
      'dir',
      `header:mobile-chromium-${process.platform}.png`,
    )

    const targets = resolveBaselineTargets({
      testFile: TEST_FILE,
      reporterTitlePath: REPORTER_TITLE_PATH,
      declarations: [
        {
          visualName: 'dir/header:mobile',
          kind: 'named',
          declaredName: 'dir/header:mobile.png',
          occurrenceIndex: 1,
        },
      ],
      config: {
        configDir: process.cwd(),
        testDir: TEST_DIR,
        snapshotDir: TEST_DIR,
        projectName: 'chromium',
        snapshotSuffix: process.platform,
      },
      snapshotPathExists: (snapshotPath) => snapshotPath === arrayVariantPath,
    } as Parameters<typeof resolveBaselineTargets>[0])

    expect(targets).toEqual([
      {
        visualName: 'dir/header:mobile',
        attachmentBaseName: 'dir/header:mobile',
        artifactBaseName: 'dir-header-mobile',
        snapshotPath: arrayVariantPath,
      },
    ])
  })
})
