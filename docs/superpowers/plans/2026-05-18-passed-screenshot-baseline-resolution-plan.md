# Passed Screenshot Baseline Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve and display exact baseline screenshots for passed named and unnamed Playwright screenshot assertions in Crvy Rprtr without patching Playwright or guessing from the filesystem.

**Architecture:** Add a dedicated snapshot path resolver that mirrors Playwright's screenshot path semantics, extend screenshot declaration extraction with occurrence metadata, and route reporter baseline copying through the resolver using explicit reporter options for custom template support. Keep the existing `declared-only` fallback when the resolved file does not exist.

**Tech Stack:** TypeScript, Bun, Playwright reporter API, Bun test, Zod-backed report model, Svelte UI

---

## File Structure

- `src/snapshot-path-resolver.ts` — deterministic mirror of Playwright screenshot snapshot naming and template expansion rules for named and unnamed assertions.
- `src/reporter-utils.ts` — extracts named and unnamed screenshot declarations from Playwright runtime steps, including occurrence indexes and duplicate-safe visual names.
- `src/reporter.ts` — captures reporter runtime metadata, threads explicit snapshot options into the resolver, and copies resolved baselines into Crvy Rprtr's screenshot directory.
- `tests/snapshot-path-resolver.test.ts` — unit coverage for default-layout, custom-template, unnamed, duplicate, and long-title resolution behavior.
- `tests/reporter-utils.test.ts` — extraction coverage for duplicate named declarations and unnamed declaration ordering.
- `tests/offline.test.ts` — reporter integration coverage for named and unnamed baseline copying with resolver-backed paths.
- `README.md` — public documentation for the new reporter options and exact-fallback behavior.

---

### Task 1: Add a deterministic snapshot path resolver for named screenshots

**Files:**

- Create: `src/snapshot-path-resolver.ts`
- Create: `tests/snapshot-path-resolver.test.ts`

- [ ] **Step 1: Write failing resolver tests for default and custom named screenshot paths**

```ts
import { describe, expect, test } from 'bun:test'
import { join } from 'path'

import { resolveBaselineTargets } from '../src/snapshot-path-resolver'

const TEST_DIR = join(process.cwd(), 'tests')
const TEST_FILE = join(TEST_DIR, 'example.spec.ts')
const REPORTER_TITLE_PATH = ['', 'chromium', 'example.spec.ts', 'Suite', 'visual pass']

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
        snapshotPath: join(TEST_DIR, 'custom-snapshots', 'chromium', 'example.spec.ts', 'header.png'),
      },
    ])
  })
})
```

- [ ] **Step 2: Run the resolver test file to verify it fails before implementation**

Run: `bun test tests/snapshot-path-resolver.test.ts`
Expected: FAIL with `Cannot find module '../src/snapshot-path-resolver'`.

- [ ] **Step 3: Create `src/snapshot-path-resolver.ts` with named-path resolution primitives**

```ts
import { createHash } from 'crypto'
import { basename, dirname, extname, join, parse, relative, resolve } from 'path'

import type { ScreenshotDeclaration } from './reporter-utils.ts'

const DEFAULT_SCREENSHOT_TEMPLATE =
  '{snapshotDir}/{testFileDir}/{testFileName}-snapshots/{arg}{-projectName}{-snapshotSuffix}{ext}'
const WINDOWS_FILESYSTEM_FRIENDLY_LENGTH = 60

export interface SnapshotResolverConfig {
  configDir: string
  testDir: string
  snapshotDir: string
  projectName: string
  snapshotSuffix: string
  snapshotPathTemplate?: string
  toHaveScreenshotPathTemplate?: string
}

export interface SnapshotResolverInput {
  testFile: string
  reporterTitlePath: string[]
  declarations: readonly ScreenshotDeclaration[]
  config: SnapshotResolverConfig
}

export interface ResolvedBaselineTarget {
  visualName: string
  attachmentBaseName: string
  snapshotPath: string
}

function sanitizeForFilePath(value: string): string {
  return value.replace(/[\x00-\x2C\x2E-\x2F\x3A-\x40\x5B-\x60\x7B-\x7F]+/g, '-')
}

function trimLongString(value: string, length = 100): string {
  if (value.length <= length) return value
  const hash = createHash('sha1').update(value).digest('hex')
  const middle = `-${hash.slice(0, 5)}-`
  const start = Math.floor((length - middle.length) / 2)
  const end = length - middle.length - start
  return value.slice(0, start) + middle + value.slice(-end)
}

function sanitizeFilePathBeforeExtension(filePath: string, extension = extname(filePath)): string {
  const base = filePath.slice(0, filePath.length - extension.length)
  return sanitizeForFilePath(base) + extension
}

function addSuffixToFilePath(filePath: string, suffix: string): string {
  const extension = extname(filePath)
  return filePath.slice(0, filePath.length - extension.length) + suffix + extension
}

function normalizedSnapshotDir(config: SnapshotResolverConfig): string {
  return resolve(config.configDir, config.snapshotDir)
}

function templateValue(template: string, token: string, value: string): string {
  return template.replace(new RegExp(`\\{(.)?${token}\\}`, 'g'), (_, prefix: string | undefined) =>
    value === '' ? '' : `${prefix ?? ''}${value}`,
  )
}

function applyTemplate(input: SnapshotResolverInput, nameArgument: string, extension: string): string {
  const template =
    input.config.toHaveScreenshotPathTemplate ?? input.config.snapshotPathTemplate ?? DEFAULT_SCREENSHOT_TEMPLATE

  const relativeTestFilePath = relative(input.config.testDir, input.testFile)
  const parsed = parse(relativeTestFilePath)
  let snapshotPath = template
  snapshotPath = templateValue(snapshotPath, 'testDir', input.config.testDir)
  snapshotPath = templateValue(snapshotPath, 'snapshotDir', normalizedSnapshotDir(input.config))
  snapshotPath = templateValue(snapshotPath, 'snapshotSuffix', input.config.snapshotSuffix)
  snapshotPath = templateValue(snapshotPath, 'testFileDir', parsed.dir)
  snapshotPath = templateValue(snapshotPath, 'platform', process.platform)
  snapshotPath = templateValue(snapshotPath, 'projectName', sanitizeForFilePath(input.config.projectName))
  snapshotPath = templateValue(snapshotPath, 'testName', '')
  snapshotPath = templateValue(snapshotPath, 'testFileName', parsed.base)
  snapshotPath = templateValue(snapshotPath, 'testFilePath', relativeTestFilePath)
  snapshotPath = templateValue(snapshotPath, 'arg', nameArgument)
  snapshotPath = templateValue(snapshotPath, 'ext', extension)
  return resolve(input.config.configDir, snapshotPath)
}

function resolveNamedTarget(
  input: SnapshotResolverInput,
  declaration: ScreenshotDeclaration & { kind: 'named'; declaredName: string },
): ResolvedBaselineTarget {
  const nameWithExtension = `${declaration.declaredName}.png`
  const relativeOutputPath =
    declaration.occurrenceIndex === 1
      ? nameWithExtension
      : addSuffixToFilePath(nameWithExtension, `-${declaration.occurrenceIndex - 1}`)
  const extension = '.png'
  const nameArgument = join(dirname(declaration.declaredName), basename(declaration.declaredName, extension))

  return {
    visualName: declaration.visualName,
    attachmentBaseName: declaration.visualName,
    snapshotPath: applyTemplate(input, nameArgument, extension),
  }
}

export function resolveBaselineTargets(input: SnapshotResolverInput): ResolvedBaselineTarget[] {
  return input.declarations
    .filter(
      (declaration): declaration is ScreenshotDeclaration & { kind: 'named'; declaredName: string } =>
        declaration.kind === 'named' && declaration.declaredName !== undefined,
    )
    .map((declaration) => resolveNamedTarget(input, declaration))
}

export { sanitizeForFilePath, trimLongString, sanitizeFilePathBeforeExtension, addSuffixToFilePath }
```

- [ ] **Step 4: Run the named resolver tests again**

Run: `bun test tests/snapshot-path-resolver.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit the named resolver foundation**

```bash
git add src/snapshot-path-resolver.ts tests/snapshot-path-resolver.test.ts
git commit -m "feat: add named screenshot baseline resolver"
```

---

### Task 2: Extend declaration extraction and resolver logic for duplicates and unnamed screenshots

**Files:**

- Create: `tests/reporter-utils.test.ts`
- Modify: `src/reporter-utils.ts`
- Modify: `src/snapshot-path-resolver.ts`
- Modify: `tests/snapshot-path-resolver.test.ts`

- [ ] **Step 1: Add failing tests for duplicate named declarations, unnamed declarations, and long-title unnamed resolution**

```ts
import { describe, expect, test } from 'bun:test'
import { basename, join } from 'path'

import { extractScreenshotDeclarations } from '../src/reporter-utils'
import { resolveBaselineTargets } from '../src/snapshot-path-resolver'

test('extractScreenshotDeclarations keeps duplicate names distinct and ordered', () => {
  expect(
    extractScreenshotDeclarations([
      {
        title: 'outer step',
        steps: [
          { title: 'Expect "toHaveScreenshot(header.png)"', steps: [] },
          { title: 'Expect "toHaveScreenshot(header.png)"', steps: [] },
          { title: 'Expect "toHaveScreenshot"', steps: [] },
        ],
      },
    ] as any),
  ).toEqual([
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
    {
      visualName: '__unnamed-screenshot-1',
      kind: 'unnamed',
      occurrenceIndex: 1,
    },
  ])
})

describe('resolveBaselineTargets unnamed screenshots', () => {
  test('resolves an unnamed screenshot using Playwright anonymous naming rules', () => {
    const targets = resolveBaselineTargets({
      testFile: join(process.cwd(), 'tests/example.spec.ts'),
      reporterTitlePath: ['', 'chromium', 'example.spec.ts', 'Suite', 'visual pass'],
      declarations: [
        {
          visualName: '__unnamed-screenshot-1',
          kind: 'unnamed',
          occurrenceIndex: 1,
        },
      ],
      config: {
        configDir: process.cwd(),
        testDir: join(process.cwd(), 'tests'),
        snapshotDir: join(process.cwd(), 'tests'),
        projectName: 'chromium',
        snapshotSuffix: process.platform,
      },
    })

    expect(targets).toEqual([
      {
        visualName: '__unnamed-screenshot-1',
        attachmentBaseName: '__unnamed-screenshot-1',
        snapshotPath: join(
          process.cwd(),
          'tests',
          'example.spec.ts-snapshots',
          `Suite-visual-pass-1-chromium-${process.platform}.png`,
        ),
      },
    ])
  })

  test('trims long unnamed screenshot titles with the same hash format Playwright uses', () => {
    const longReporterTitlePath = [
      '',
      'chromium',
      'example.spec.ts',
      'A suite title that is intentionally very long to exercise trimming',
      'and an equally long test title to force a hashed anonymous screenshot name',
    ]

    const [target] = resolveBaselineTargets({
      testFile: join(process.cwd(), 'tests/example.spec.ts'),
      reporterTitlePath: longReporterTitlePath,
      declarations: [
        {
          visualName: '__unnamed-screenshot-1',
          kind: 'unnamed',
          occurrenceIndex: 1,
        },
      ],
      config: {
        configDir: process.cwd(),
        testDir: join(process.cwd(), 'tests'),
        snapshotDir: join(process.cwd(), 'tests'),
        projectName: 'chromium',
        snapshotSuffix: process.platform,
      },
    })

    expect(basename(target.snapshotPath)).toMatch(/-[0-9a-f]{5}-/)
    expect(basename(target.snapshotPath)).toEndWith(`-chromium-${process.platform}.png`)
  })
})
```

- [ ] **Step 2: Run the new extraction and unnamed resolver tests to verify they fail**

Run: `bun test tests/reporter-utils.test.ts tests/snapshot-path-resolver.test.ts`
Expected: FAIL because `ScreenshotDeclaration` does not yet include `kind`/`occurrenceIndex`, duplicates are still deduplicated, and unnamed paths are not resolved.

- [ ] **Step 3: Replace the current declaration extractor with duplicate-safe metadata extraction**

```ts
import type { TestStep } from '@playwright/test/reporter'

const NAMED_SCREENSHOT_STEP_TITLE = /toHaveScreenshot\((.+?)\)/
const UNNAMED_SCREENSHOT_STEP_TITLE = /^Expect "toHaveScreenshot"(?:\s|$)/
const SYNTHETIC_SCREENSHOT_PREFIX = '__unnamed-screenshot-'

export interface ScreenshotDeclaration {
  visualName: string
  kind: 'named' | 'unnamed'
  declaredName?: string
  occurrenceIndex: number
}

export interface AttachmentData {
  name: string
  path: string
  contentType: string
}

interface ExtractionState {
  readonly declarations: ScreenshotDeclaration[]
  readonly namedOccurrences: Map<string, number>
  nextUnnamedIndex: number
}

function addVisualSuffix(visualName: string, occurrenceIndex: number): string {
  if (occurrenceIndex === 1) return visualName
  const slashIndex = visualName.lastIndexOf('/')
  return slashIndex === -1
    ? `${visualName}-${occurrenceIndex - 1}`
    : `${visualName.slice(0, slashIndex + 1)}${visualName.slice(slashIndex + 1)}-${occurrenceIndex - 1}`
}

function normalizeNamedScreenshot(titleMatch: string, state: ExtractionState): ScreenshotDeclaration | null {
  const unquotedName = titleMatch.trim().replace(/^['"`]|['"`]$/g, '')
  if (unquotedName === '') return null

  const normalizedPath = unquotedName.replace(/\\/g, '/')
  const declaredName = normalizedPath.replace(/\.png$/, '')
  if (declaredName === '') return null

  const occurrenceIndex = (state.namedOccurrences.get(declaredName) ?? 0) + 1
  state.namedOccurrences.set(declaredName, occurrenceIndex)

  return {
    visualName: addVisualSuffix(declaredName, occurrenceIndex),
    kind: 'named',
    declaredName,
    occurrenceIndex,
  }
}

function visitStep(step: TestStep, state: ExtractionState): boolean {
  const declarationsBeforeChildren = state.declarations.length

  for (const nestedStep of step.steps) {
    visitStep(nestedStep, state)
  }

  const namedMatch = step.title.match(NAMED_SCREENSHOT_STEP_TITLE)
  if (namedMatch?.[1] !== undefined) {
    const declaration = normalizeNamedScreenshot(namedMatch[1], state)
    if (declaration !== null) {
      state.declarations.push(declaration)
      return true
    }
  }

  const hasNestedScreenshotDeclaration = state.declarations.length > declarationsBeforeChildren
  if (UNNAMED_SCREENSHOT_STEP_TITLE.test(step.title) && !hasNestedScreenshotDeclaration) {
    const occurrenceIndex = state.nextUnnamedIndex
    state.declarations.push({
      visualName: `${SYNTHETIC_SCREENSHOT_PREFIX}${occurrenceIndex}`,
      kind: 'unnamed',
      occurrenceIndex,
    })
    state.nextUnnamedIndex += 1
    return true
  }

  return hasNestedScreenshotDeclaration
}

export function extractScreenshotDeclarations(steps: readonly TestStep[]): ScreenshotDeclaration[] {
  const state: ExtractionState = {
    declarations: [],
    namedOccurrences: new Map(),
    nextUnnamedIndex: 1,
  }

  for (const step of steps) {
    visitStep(step, state)
  }

  return state.declarations
}

export function extractScreenshotNames(steps: readonly TestStep[]): string[] {
  return extractScreenshotDeclarations(steps).map(({ visualName }) => visualName)
}
```

- [ ] **Step 4: Extend `src/snapshot-path-resolver.ts` to mirror anonymous Playwright naming and duplicate-aware attachment names**

```ts
function reporterTitlesWithoutProjectAndFile(reporterTitlePath: string[]): string[] {
  return reporterTitlePath.slice(3).filter((part) => part !== '')
}

function anonymousName(reporterTitlePath: string[], occurrenceIndex: number): string {
  const rawAnonymousName = `${reporterTitlesWithoutProjectAndFile(reporterTitlePath).join(' ')} ${occurrenceIndex}.png`
  return sanitizeFilePathBeforeExtension(trimLongString(rawAnonymousName), '.png')
}

function resolveTarget(input: SnapshotResolverInput, declaration: ScreenshotDeclaration): ResolvedBaselineTarget {
  if (declaration.kind === 'named' && declaration.declaredName !== undefined) {
    return resolveNamedTarget(input, declaration)
  }

  const anonymousFileName = anonymousName(input.reporterTitlePath, declaration.occurrenceIndex)
  const extension = '.png'
  const nameArgument = join(dirname(anonymousFileName), basename(anonymousFileName, extension))

  return {
    visualName: declaration.visualName,
    attachmentBaseName: declaration.visualName,
    snapshotPath: applyTemplate(input, nameArgument, extension),
  }
}

export function resolveBaselineTargets(input: SnapshotResolverInput): ResolvedBaselineTarget[] {
  return input.declarations.map((declaration) => resolveTarget(input, declaration))
}
```

- [ ] **Step 5: Run the extraction and resolver suites again**

Run: `bun test tests/reporter-utils.test.ts tests/snapshot-path-resolver.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit duplicate and unnamed resolution support**

```bash
git add src/reporter-utils.ts src/snapshot-path-resolver.ts tests/reporter-utils.test.ts tests/snapshot-path-resolver.test.ts
git commit -m "feat: resolve unnamed and duplicate screenshot baselines"
```

---

### Task 3: Integrate the resolver into the reporter and add custom-template reporter options

**Files:**

- Modify: `src/reporter.ts`
- Modify: `tests/offline.test.ts`

- [ ] **Step 1: Add failing reporter integration tests for explicit-template named resolution and unnamed baseline copying**

```ts
test('copies a named screenshot baseline using an explicit toHaveScreenshot path template', async () => {
  const { CrvyRprtr } = await import('../src/reporter')

  const customSnapshotDir = join(TEST_SNAPSHOT_DIR, 'custom-layout')
  await mkdir(join(customSnapshotDir, 'chromium', 'example.spec.ts'), { recursive: true })
  await writeFile(join(customSnapshotDir, 'chromium', 'example.spec.ts', 'header.png'), 'baseline image')

  const reporter = new CrvyRprtr({
    screenshotDir: TEST_SCREENSHOT_DIR,
    reportHtmlPath: TEST_ARTIFACT_PATH,
    playwrightSnapshotDir: customSnapshotDir,
    playwrightToHaveScreenshotPathTemplate: '{snapshotDir}/{projectName}/{testFilePath}/{arg}{ext}',
  })

  const sent: unknown[] = []
  const reporterAny = reporter as unknown as {
    send: (message: unknown) => void
    onTestEnd: (test: object, result: object) => Promise<void>
  }
  reporterAny.send = (message: unknown): void => {
    sent.push(message)
  }

  await reporterAny.onTestEnd(
    {
      id: 'test-visual-custom-template',
      title: 'visual pass',
      location: { file: join(process.cwd(), 'tests/example.spec.ts'), line: 10 },
      parent: {
        project: () => ({
          name: 'chromium',
          testDir: join(process.cwd(), 'tests'),
          snapshotDir: join(process.cwd(), 'tests'),
        }),
      },
    },
    {
      status: 'passed',
      errors: [],
      duration: 100,
      attachments: [],
      steps: [{ title: 'outer step', steps: [{ title: 'Expect "toHaveScreenshot(header.png)"', steps: [] }] }],
    },
  )

  expect((sent[0] as { data: { attachments: Array<{ name: string; path: string }> } }).data.attachments).toMatchObject([
    {
      name: 'header-expected.png',
      path: 'test-visual-custom-template/header-expected.png',
    },
  ])
})

test('copies an unnamed screenshot baseline using titlePath metadata from onTestBegin', async () => {
  const { CrvyRprtr } = await import('../src/reporter')

  await mkdir(TEST_SNAPSHOT_DIR, { recursive: true })
  await writeFile(join(TEST_SNAPSHOT_DIR, `Suite-visual-pass-1-chromium-${process.platform}.png`), 'baseline image')

  const reporter = new CrvyRprtr({
    screenshotDir: TEST_SCREENSHOT_DIR,
    reportHtmlPath: TEST_ARTIFACT_PATH,
  })

  const sent: unknown[] = []
  const reporterAny = reporter as unknown as {
    send: (message: unknown) => void
    onTestBegin: (test: object) => void
    onTestEnd: (test: object, result: object) => Promise<void>
  }
  reporterAny.send = (message: unknown): void => {
    sent.push(message)
  }

  reporterAny.onTestBegin({
    id: 'test-visual-unnamed-copy',
    title: 'visual pass',
    titlePath: () => ['', 'chromium', 'example.spec.ts', 'Suite', 'visual pass'],
    location: { file: join(process.cwd(), 'tests/example.spec.ts'), line: 10 },
    parent: {
      title: 'Suite',
      type: 'describe',
      project: () => ({
        name: 'chromium',
        testDir: join(process.cwd(), 'tests'),
        snapshotDir: join(process.cwd(), 'tests'),
      }),
      parent: undefined,
    },
  })

  await reporterAny.onTestEnd(
    {
      id: 'test-visual-unnamed-copy',
      title: 'visual pass',
      titlePath: () => ['', 'chromium', 'example.spec.ts', 'Suite', 'visual pass'],
      location: { file: join(process.cwd(), 'tests/example.spec.ts'), line: 10 },
      parent: {
        project: () => ({
          name: 'chromium',
          testDir: join(process.cwd(), 'tests'),
          snapshotDir: join(process.cwd(), 'tests'),
        }),
      },
    },
    {
      status: 'passed',
      errors: [],
      duration: 100,
      attachments: [],
      steps: [{ title: 'outer step', steps: [{ title: 'Expect "toHaveScreenshot"', steps: [] }] }],
    },
  )

  expect((sent[0] as { data: { attachments: Array<{ name: string; path: string }> } }).data.attachments).toMatchObject([
    {
      name: '__unnamed-screenshot-1-expected.png',
      path: 'test-visual-unnamed-copy/__unnamed-screenshot-1-expected.png',
    },
  ])
})
```

- [ ] **Step 2: Run the reporter integration suite to verify it fails**

Run: `bun test tests/offline.test.ts`
Expected: FAIL because the reporter does not yet expose snapshot-template options, does not retain reporter title-path metadata, and still hardcodes default baseline paths.

- [ ] **Step 3: Update `src/reporter.ts` to store runtime metadata and call the resolver**

```ts
import { mkdir, copyFile, writeFile } from 'fs/promises'
import { dirname, join, resolve } from 'path'

import type { Reporter, FullConfig, Suite, TestCase, TestResult, FullResult } from '@playwright/test/reporter'
import pLimit from 'p-limit'

import { writeReportArtifact } from './report-artifact.ts'
import { type AttachmentData, extractScreenshotDeclarations } from './reporter-utils.ts'
import { resolveBaselineTargets } from './snapshot-path-resolver.ts'

export interface CrvyRprtrOptions {
  serverUrl?: string
  screenshotDir?: string
  offlineReportPath?: string
  reportHtmlPath?: string
  playwrightSnapshotDir?: string
  playwrightSnapshotPathTemplate?: string
  playwrightToHaveScreenshotPathTemplate?: string
}

export class CrvyRprtr implements Reporter {
  private configDir = process.cwd()
  private testMetadata = new Map<string, { reporterTitlePath: string[] }>()
  private playwrightSnapshotDir?: string
  private playwrightSnapshotPathTemplate?: string
  private playwrightToHaveScreenshotPathTemplate?: string

  constructor(options: CrvyRprtrOptions = {}) {
    this.serverUrl = options.serverUrl ?? 'ws://localhost:3000'
    this.screenshotDir = options.screenshotDir ?? './screenshots'
    this.workerIndex = parseInt(process.env.TEST_WORKER_INDEX ?? '0', 10) || 0
    this.offlineReportPath = options.offlineReportPath ?? `./crvy-rprtr-${this.workerIndex}.json`
    this.reportHtmlPath = options.reportHtmlPath ?? './crvy-rprtr.html'
    this.playwrightSnapshotDir = options.playwrightSnapshotDir
    this.playwrightSnapshotPathTemplate = options.playwrightSnapshotPathTemplate
    this.playwrightToHaveScreenshotPathTemplate = options.playwrightToHaveScreenshotPathTemplate
  }

  async onBegin(config: FullConfig, suite: Suite): Promise<void> {
    this.configDir = config.configFile ? dirname(config.configFile) : config.rootDir
    console.log(`[CrvyRprtr] Starting run with ${suite.allTests().length} tests`)
    await mkdir(this.screenshotDir, { recursive: true })
    this.connect()
  }

  onTestBegin(test: TestCase): void {
    const titlePath: string[] = []
    let suite: Suite | undefined = test.parent
    while (suite && suite.type === 'describe') {
      titlePath.unshift(suite.title)
      suite = suite.parent
    }

    const reporterTitlePath =
      typeof test.titlePath === 'function'
        ? test.titlePath()
        : ['', test.parent.project()?.name ?? 'chromium', test.location.file, ...titlePath, test.title]

    this.testMetadata.set(test.id, { reporterTitlePath })

    this.send({
      type: 'test-begin',
      data: {
        id: test.id,
        title: test.title,
        titlePath,
        browser: test.parent.project()?.name ?? 'chromium',
        location: {
          file: test.location.file,
          line: test.location.line,
        },
      },
    })
  }

  private async copySnapshotBaselines(
    test: TestCase,
    status: TestResult['status'],
    screenshotDeclarations: ReturnType<typeof extractScreenshotDeclarations>,
    savedAttachments: AttachmentData[],
  ): Promise<void> {
    if (status !== 'passed') return

    const project = test.parent.project()
    const metadata = this.testMetadata.get(test.id)
    if (project === undefined || metadata === undefined) return

    const snapshotDir =
      this.playwrightSnapshotDir === undefined
        ? project.snapshotDir
        : resolve(this.configDir, this.playwrightSnapshotDir)

    const targets = resolveBaselineTargets({
      testFile: test.location.file,
      reporterTitlePath: metadata.reporterTitlePath,
      declarations: screenshotDeclarations,
      config: {
        configDir: this.configDir,
        testDir: project.testDir,
        snapshotDir,
        projectName: project.name,
        snapshotSuffix: process.platform,
        snapshotPathTemplate: this.playwrightSnapshotPathTemplate,
        toHaveScreenshotPathTemplate: this.playwrightToHaveScreenshotPathTemplate,
      },
    })

    const testScreenshotDir = join(this.screenshotDir, this.sanitizeId(test.id))
    const limit = pLimit(MAX_CONCURRENT_FILE_OPS)

    await Promise.all(
      targets.map((target) =>
        limit(async () => {
          const destName = `${target.attachmentBaseName}-expected.png`
          const destPath = join(testScreenshotDir, destName)
          try {
            await mkdir(dirname(destPath), { recursive: true })
            await copyFile(target.snapshotPath, destPath)
            savedAttachments.push({
              name: destName,
              path: `${this.sanitizeId(test.id)}/${destName}`,
              contentType: 'image/png',
            })
            console.log(`[CrvyRprtr] Attached baseline: ${target.snapshotPath}`)
          } catch {
            // keep declared-only when no exact baseline exists
          }
        }),
      ),
    )
  }
}
```

- [ ] **Step 4: Run the reporter suite again**

Run: `bun test tests/offline.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit the reporter integration**

```bash
git add src/reporter.ts tests/offline.test.ts
git commit -m "feat: resolve passed screenshot baselines through Playwright rules"
```

---

### Task 4: Document the new reporter options and verify the full change set

**Files:**

- Modify: `README.md`

- [ ] **Step 1: Update the README reporter options table and passed screenshot section**

```md
| Option                                   | Type     | Default                        | Description                                                                |
| ---------------------------------------- | -------- | ------------------------------ | -------------------------------------------------------------------------- |
| `serverUrl`                              | `string` | `"ws://localhost:3000"`        | WebSocket URL of the Crvy Rprtr server                                     |
| `screenshotDir`                          | `string` | `"./screenshots"`              | Directory for saving screenshot artifacts                                  |
| `offlineReportPath`                      | `string` | `"./crvy-rprtr-{worker}.json"` | Path for offline report when server is unavailable                         |
| `reportHtmlPath`                         | `string` | `"./crvy-rprtr.html"`          | Path for the browser-openable static report HTML                           |
| `playwrightSnapshotDir`                  | `string` | `undefined`                    | Override the Playwright snapshot directory used for passed baseline lookup |
| `playwrightSnapshotPathTemplate`         | `string` | `undefined`                    | Mirror Playwright `snapshotPathTemplate` for passed baseline resolution    |
| `playwrightToHaveScreenshotPathTemplate` | `string` | `undefined`                    | Mirror Playwright `expect.toHaveScreenshot.pathTemplate`; takes precedence |
```

And replace the passed screenshot modes section with:

```md
## Passed Screenshot Modes

Crvy Rprtr keeps passed Playwright screenshot assertions visible in two fallback modes when Playwright does not emit a full passing comparison payload:

- `baseline-only`: Crvy Rprtr resolved the exact expected snapshot path and copied that baseline into the screenshot directory, so the UI can show the stored baseline.
- `declared-only`: the screenshot assertion was detected, but Crvy Rprtr could not resolve an exact snapshot file and therefore keeps the honest text-only fallback.

Crvy Rprtr does not auto-read Playwright config for snapshot template discovery. If your suite uses custom snapshot layout, pass the matching `playwrightSnapshotDir`, `playwrightSnapshotPathTemplate`, or `playwrightToHaveScreenshotPathTemplate` reporter options explicitly.
```

- [ ] **Step 2: Run the focused tests plus build, typecheck, and lint verification**

Run: `bun test tests/snapshot-path-resolver.test.ts tests/reporter-utils.test.ts tests/offline.test.ts tests/report-state.test.ts`
Expected: PASS.

Run: `bun run build`
Expected: PASS and updated build artifacts written to `dist/`.

Run: `bun run typecheck`
Expected: PASS with no TypeScript errors.

Run: `bun run lint`
Expected: PASS with no oxlint errors.

- [ ] **Step 3: Commit the docs and verification-ready change set**

```bash
git add README.md
git commit -m "docs: document passed screenshot baseline resolution options"
```
