# Stale `actual` URL on Passing Rerun — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop carrying stale `/file/<test-results>` URLs from a prior failed run into a later passed run, so the UI shows the persistent baseline (via `/baseline/...`) instead of a broken image after Playwright wipes its `outputDir` between runs.

**Architecture:** Narrow `isReusablePassingImage` in `src/report-state.ts` so that comparison images (those carrying `actual` or `diff` URLs) are no longer considered reusable on a passed run. Their `actual` URLs are ephemeral — they point at Playwright's `outputDir`, which Playwright wipes at the start of every run, so carrying them forward always produces a dangling pointer in live mode. After this change, when the new run produces no attachments for a still-declared visual name, the image falls through to `declared-only`, and the existing `enrichDeclaredBaselines` step in `src/server/handlers.ts` rewrites it to `baseline-only` with an `expect` URL of `/baseline/<testId>/<retry>/<visualName>` (resolved on the server against the persistent snapshot directory via `resolveBaselineSnapshotPath`).

Defense in depth: when a `baseline-only` image _is_ carried forward (the still-supported case), strip any stray `actual`/`diff` fields from the previous record so that a mixed-source prior result cannot leak partial stale URLs into the new run.

**Tech Stack:** TypeScript, Bun (`bun test`).

**Context:** This is the fix for the bug the user actually reproduced. After approving a first-run baseline failure and re-running, the test passes, Playwright emits no attachments, and the UI is left showing a broken image because the previous run's `/file/...` URL survives into the new result. The companion plan `2026-06-18-cross-os-path-handling.md` is independent and addresses a different (theoretical) defect in path encoding; it does not need to land for this fix to work.

---

## Reproducer (verified before writing this plan)

```ts
const state = createMutableReportState('./screenshots')

applyTestBeginEvent(state, {
  id: 't1',
  title: 'visual',
  titlePath: ['Suite'],
  browser: 'chromium',
  location: { file: 'example.spec.ts', line: 1 },
})
applyTestEndEvent(state, {
  id: 't1',
  status: 'failed',
  attachments: [
    { name: 'header-actual.png', path: '/tmp/test-results/t1/header-actual.png', contentType: 'image/png' },
  ],
  visualNames: ['header'],
  visualDeclarations: [
    { visualName: 'header', kind: 'named', declaredName: 'header', snapshotBaseName: 'header', occurrenceIndex: 1 },
  ],
})
// → { header: { actual: '/file/%2Ftmp%2Ftest-results%2Ft1%2Fheader-actual.png', source: 'comparison' } }

applyTestBeginEvent(state, {
  id: 't1',
  title: 'visual',
  titlePath: ['Suite'],
  browser: 'chromium',
  location: { file: 'example.spec.ts', line: 1 },
})
applyTestEndEvent(state, {
  id: 't1',
  status: 'passed',
  attachments: [],
  visualNames: ['header'],
  visualDeclarations: [
    { visualName: 'header', kind: 'named', declaredName: 'header', snapshotBaseName: 'header', occurrenceIndex: 1 },
  ],
})
// CURRENT:  { header: { actual: '/file/%2Ftmp%2Ftest-results%2Ft1%2Fheader-actual.png', source: 'comparison' } }  ← stale
// EXPECTED: { header: { source: 'declared-only' } }  ← ready for enrichDeclaredBaselines to install /baseline/...
```

---

## File Structure

- `src/report-state.ts` — **modify.** Two surgical changes:
  1. `isReusablePassingImage` (lines ~39-47) drops the `source === 'comparison'` branch; only `baseline-only` is reusable.
  2. `preservePreviousPassingImages` (lines ~53-85) sanitises the carried-forward image to `{ expect, source: 'baseline-only' }` so no `actual` or `diff` can leak through from a previous mixed-source record.
- `tests/report-state.test.ts` — **modify.** Add a regression test that drives the failed→passed two-run sequence and asserts the passed-run image no longer carries the failed-run `actual` URL. The existing "keeps carry-forward only for image names still present in a later passing run" test (lines 67-124) continues to pass because it uses `baseline-only` inputs.

No other files change. `src/server/handlers.ts:34-54` (`enrichDeclaredBaselines`) already runs unconditionally for passed tests and already short-circuits on `source !== 'declared-only'` — once Task 1 lets the image fall through to `declared-only`, enrichment takes over with no further changes.

---

### Task 1: Stop reusing comparison images on passed reruns

**Files:**

- Modify: `src/report-state.ts` (`isReusablePassingImage` lines ~39-47)
- Test: `tests/report-state.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/report-state.test.ts` inside the existing top-level `describe('report-state visual classification', ...)` block. The block already imports `applyTestBeginEvent`, `applyTestEndEvent`, `createMutableReportState` from `'../src/report-state'`.

```ts
test('does not carry a stale comparison actual URL into a later passing run', () => {
  const state = createMutableReportState('./screenshots')

  applyTestBeginEvent(state, {
    id: 't-stale',
    title: 'visual',
    titlePath: ['Suite'],
    browser: 'chromium',
    location: { file: 'tests/example.spec.ts', line: 10 },
  })

  applyTestEndEvent(state, {
    id: 't-stale',
    status: 'failed',
    attachments: [
      {
        name: 'header-actual.png',
        path: '/tmp/test-results/t-stale/header-actual.png',
        contentType: 'image/png',
      },
    ],
    visualNames: ['header'],
    visualDeclarations: [
      {
        visualName: 'header',
        kind: 'named',
        declaredName: 'header',
        snapshotBaseName: 'header',
        occurrenceIndex: 1,
      },
    ],
  })

  const firstRunActual = state.reportData.tests['t-stale']?.results?.[0]?.images?.['header']?.actual
  expect(firstRunActual).toBe('/file/%2Ftmp%2Ftest-results%2Ft-stale%2Fheader-actual.png')

  applyTestBeginEvent(state, {
    id: 't-stale',
    title: 'visual',
    titlePath: ['Suite'],
    browser: 'chromium',
    location: { file: 'tests/example.spec.ts', line: 10 },
  })

  applyTestEndEvent(state, {
    id: 't-stale',
    status: 'passed',
    attachments: [],
    visualNames: ['header'],
    visualDeclarations: [
      {
        visualName: 'header',
        kind: 'named',
        declaredName: 'header',
        snapshotBaseName: 'header',
        occurrenceIndex: 1,
      },
    ],
  })

  const passedImage = state.reportData.tests['t-stale']?.results?.[0]?.images?.['header']
  expect(passedImage?.actual).toBeUndefined()
  expect(passedImage?.source).toBe('declared-only')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/report-state.test.ts -t "stale comparison actual URL"`
Expected: FAIL — `expected undefined, received '/file/%2Ftmp%2Ftest-results%2Ft-stale/header-actual.png'` and `expected 'declared-only', received 'comparison'`. The current `isReusablePassingImage` treats `actual` + no `diff` as reusable, so the previous comparison image is carried over verbatim.

- [ ] **Step 3: Write minimal implementation**

In `src/report-state.ts`, replace `isReusablePassingImage` (lines ~39-47) with the narrowed version that no longer treats `comparison` as reusable:

```ts
function isReusablePassingImage(image: Images): boolean {
  const source = image.source ?? classifyImage(image)
  return source === 'baseline-only'
}
```

The `comparison` branch was the only place that treated `actual` as a reusable URL; live-mode `actual` URLs point at Playwright's `outputDir` which is wiped at the start of every run, so preserving them always produces a dangling pointer.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/report-state.test.ts`
Expected: PASS — the new regression test passes, and the existing "keeps carry-forward only for image names still present in a later passing run" test (which uses `baseline-only` inputs only) still passes because `baseline-only` remains reusable.

- [ ] **Step 5: Run the full test suite**

Run: `bun test`
Expected: all tests pass.

- [ ] **Step 6: Lint and commit**

Run: `bun run lint`
Expected: no new errors.

```bash
git add src/report-state.ts tests/report-state.test.ts
git commit -m "fix(report-state): drop stale comparison actual URL on passed reruns"
```

---

### Task 2: Sanitise preserved baseline-only images (defense in depth)

**Files:**

- Modify: `src/report-state.ts` (`preservePreviousPassingImages` lines ~53-85)
- Test: `tests/report-state.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/report-state.test.ts`, still inside the top-level `describe('report-state visual classification', ...)` block:

```ts
test('strips stale actual and diff fields from a previously mixed-source baseline-only image', () => {
  const state = createMutableReportState('./screenshots')

  applyTestBeginEvent(state, {
    id: 't-mixed',
    title: 'visual',
    titlePath: ['Suite'],
    browser: 'chromium',
    location: { file: 'tests/example.spec.ts', line: 10 },
  })

  applyTestEndEvent(state, {
    id: 't-mixed',
    status: 'passed',
    attachments: [
      {
        name: 'header-expected',
        path: 't-mixed/header-expected',
        contentType: 'image/png',
      },
    ],
    visualNames: ['header'],
  })

  // Simulate a polluted prior record (e.g.legacy report loaded from disk that
  // carries both an expect URL and a stale actual URL from a previous failure).
  const test = state.reportData.tests['t-mixed']
  const priorImage = test?.results?.[0]?.images?.['header']
  expect(priorImage).toBeDefined()
  if (priorImage !== undefined) {
    priorImage.actual = '/file/%2Ftmp%2Ftest-results%2Ft-mixed%2Fheader-actual.png'
    priorImage.diff = '/file/%2Ftmp%2Ftest-results%2Ft-mixed%2Fheader-diff.png'
  }

  applyTestBeginEvent(state, {
    id: 't-mixed',
    title: 'visual',
    titlePath: ['Suite'],
    browser: 'chromium',
    location: { file: 'tests/example.spec.ts', line: 10 },
  })

  applyTestEndEvent(state, {
    id: 't-mixed',
    status: 'passed',
    attachments: [],
    visualNames: ['header'],
  })

  const preserved = state.reportData.tests['t-mixed']?.results?.[0]?.images?.['header']
  expect(preserved?.source).toBe('baseline-only')
  expect(preserved?.expect).toBe('/screenshots/t-mixed/header-expected')
  expect(preserved?.actual).toBeUndefined()
  expect(preserved?.diff).toBeUndefined()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/report-state.test.ts -t "strips stale actual and diff fields"`
Expected: FAIL — `expected undefined, received '/file/%2Ftmp%2Ftest-results%2Ft-mixed%2Fheader-actual.png'`. The current preservation spreads the entire previous image into the new record, including stray `actual`/`diff` fields.

- [ ] **Step 3: Write minimal implementation**

In `src/report-state.ts`, replace the carry-forward branch of `preservePreviousPassingImages` (lines ~77-84). Locate the existing block:

```ts
return {
  ...currentImages,
  [name]: {
    ...previousImage,
    source: previousImage.source ?? classifyImage(previousImage),
  },
}
```

Replace it with a sanitised shape that keeps only the persistent `expect` URL and forces `source` to `baseline-only`:

```ts
return {
  ...currentImages,
  [name]: {
    expect: previousImage.expect,
    source: 'baseline-only',
  },
}
```

`previousImage.expect` is the only durable field: it points either at `/screenshots/...` (CI mode, copied into the persistent `screenshotDir`) or at `/baseline/...` (server-resolved against the snapshot directory). Both survive across runs. `actual` and `diff` only ever point at Playwright's `outputDir`, which is wiped per run, so they must not be preserved.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/report-state.test.ts`
Expected: PASS — the new test passes, the Task 1 regression still passes, and the existing "keeps carry-forward only for image names still present in a later passing run" test (which only checks `expect` and `source`) continues to pass.

- [ ] **Step 5: Run the full test suite**

Run: `bun test`
Expected: all tests pass.

- [ ] **Step 6: Lint and commit**

Run: `bun run lint`
Expected: no new errors.

```bash
git add src/report-state.ts tests/report-state.test.ts
git commit -m "fix(report-state): strip stale actual/diff when preserving baseline-only images"
```

---

### Task 3: End-to-end verification via the server-side enrichment path

This task has no code change — it adds an integration test that proves the failed→passed progression now reaches `enrichDeclaredBaselines` and produces a `/baseline/...` `expect` URL. It guards against a future regression where the state layer is "fixed" but the enrichment wiring drifts.

**Files:**

- Modify: `tests/server-routes.test.ts`

- [ ] **Step 1: Reuse the existing `createServerApp` + `handleWebSocketMessage` scaffolding**

The `describe('declared-only baseline enrichment', ...)` block at `tests/server-routes.test.ts:1064` already shows the full pattern: build a `createServerApp({ screenshotDir, reportPath, configDir, playwrightTestDir, playwrightSnapshotDir, playwrightToHaveScreenshotPathTemplate })`, drive `test-begin` + `test-end` via `app.handleWebSocketMessage(JSON.stringify(...))`, then assert against `app.handleRequest(new Request('http://localhost/api/report'))`. Constants in scope there: `SCREENSHOT_DIR`, `SNAPSHOT_DIR`, `TMP_DIR`, `PLAYWRIGHT_TEST_DIR`, `TEST_FILE`, `CUSTOM_TEMPLATE`. The new test mirrors that block exactly, except it sends **two** `test-begin` + `test-end` cycles (failed then passed) and the assertion is that the passed-run image ends up as `baseline-only` with no `actual`.

- [ ] **Step 2: Write the integration test**

Append to `tests/server-routes.test.ts` inside the existing `describe('declared-only baseline enrichment', ...)` block (around line 1064). Use the same imports and constants already in scope at the top of the file.

```ts
test('a failed run superseded by a passed run enriches to /baseline without stale actual', async () => {
  await mkdir(join(SNAPSHOT_DIR, 'chromium', 'example.spec.ts'), { recursive: true })
  await writeFile(join(SNAPSHOT_DIR, 'chromium', 'example.spec.ts', 'header.png'), 'baseline image')

  const app = await createServerApp({
    screenshotDir: SCREENSHOT_DIR,
    reportPath: join(TMP_DIR, 'report.json'),
    configDir: process.cwd(),
    playwrightTestDir: PLAYWRIGHT_TEST_DIR,
    playwrightSnapshotDir: SNAPSHOT_DIR,
    playwrightToHaveScreenshotPathTemplate: CUSTOM_TEMPLATE,
  })

  // Run 1: failed. Playwright attachment: just an actual at an absolute test-results path.
  // In real life this is what Playwright emits on first-run baseline creation.
  await app.handleWebSocketMessage(
    JSON.stringify({
      type: 'test-begin',
      data: {
        id: 't-failed-then-passed',
        title: 'visual pass',
        titlePath: ['Suite'],
        browser: 'chromium',
        location: { file: TEST_FILE, line: 10 },
      },
    }),
  )
  await app.handleWebSocketMessage(
    JSON.stringify({
      type: 'test-end',
      data: {
        id: 't-failed-then-passed',
        status: 'failed',
        attachments: [
          {
            name: 'header-actual.png',
            path: '/tmp/test-results/t-failed-then-passed/header-actual.png',
            contentType: 'image/png',
          },
        ],
        visualNames: ['header'],
        visualDeclarations: [
          {
            visualName: 'header',
            kind: 'named',
            declaredName: 'header',
            snapshotBaseName: 'header',
            occurrenceIndex: 1,
          },
        ],
      },
    }),
  )

  // Sanity: after the failed run the image is a comparison with an /file actual.
  const afterFailed = (await (await app.handleRequest(new Request('http://localhost/api/report'))).json()) as {
    tests: Record<string, { results: { images: Record<string, { actual?: string; source?: string } }[] }>
  }
  const failedImage = afterFailed.tests['t-failed-then-passed']?.results?.[0]?.images?.['header']
  expect(failedImage?.source).toBe('comparison')
  expect(failedImage?.actual).toContain('/file/')

  // Run 2: passed, no attachments. Playwright wipes test-results before running.
  await app.handleWebSocketMessage(
    JSON.stringify({
      type: 'test-begin',
      data: {
        id: 't-failed-then-passed',
        title: 'visual pass',
        titlePath: ['Suite'],
        browser: 'chromium',
        location: { file: TEST_FILE, line: 10 },
      },
    }),
  )
  await app.handleWebSocketMessage(
    JSON.stringify({
      type: 'test-end',
      data: {
        id: 't-failed-then-passed',
        status: 'passed',
        attachments: [],
        visualNames: ['header'],
        visualDeclarations: [
          {
            visualName: 'header',
            kind: 'named',
            declaredName: 'header',
            snapshotBaseName: 'header',
            occurrenceIndex: 1,
          },
        ],
      },
    }),
  )

  const afterPassed = (await (await app.handleRequest(new Request('http://localhost/api/report'))).json()) as {
    tests: Record<string, { results: { images: Record<string, { actual?: string; expect?: string; source?: string } }[] }>
  }
  const passedImage = afterPassed.tests['t-failed-then-passed']?.results?.[0]?.images?.['header']
  expect(passedImage?.source).toBe('baseline-only')
  expect(passedImage?.expect).toBe(
    `/baseline/${encodeURIComponent('t-failed-then-passed')}/0/${encodeURIComponent('header')}`,
  )
  expect(passedImage?.actual).toBeUndefined()
})
```

- [ ] **Step 3: Run test to verify it passes**

Run: `bun test tests/server-routes.test.ts -t "failed run superseded by a passed run"`
Expected: PASS. With Task 1 in place, the run-2 `applyTestEndEvent` does not carry the run-1 comparison image forward (its `actual` URL is now treated as non-reusable). The run-2 image becomes `declared-only`, `handleTestEnd` then calls `enrichDeclaredBaselines` (which finds the on-disk baseline at `SNAPSHOT_DIR/chromium/example.spec.ts/header.png`), and `expect` is rewritten to `/baseline/t-failed-then-passed/0/header`.

If the test fails:

- `expected 'baseline-only', received 'comparison'` → Task 1 has not landed correctly; re-apply the narrowed `isReusablePassingImage`.
- `expected 'baseline-only', received 'declared-only'` → `enrichDeclaredBaselines` skipped enrichment, meaning the resolver could not find `SNAPSHOT_DIR/chromium/example.spec.ts/header.png`. Compare the fixture layout to the existing "handleTestEnd sets a /baseline expect url when the baseline resolves" test at line 1065 and align paths/constants.
- `expected undefined, received '/file/...'` → Task 2's `actual`-stripping has not landed; re-apply.

- [ ] **Step 4: Run the full test suite**

Run: `bun test`
Expected: all tests pass.

- [ ] **Step 5: Lint and commit**

Run: `bun run lint`
Expected: no new errors.

```bash
git add tests/server-routes.test.ts
git commit -m "test(server-routes): cover baseline enrichment after failed→passed progression"
```

---

## Self-Review

**Spec coverage:**

- Stop preserving stale `actual` from comparison images → Task 1 (narrows `isReusablePassingImage`).
- Defense in depth: strip stray `actual`/`diff` from preserved `baseline-only` records → Task 2.
- Prove the fix reaches `/baseline/...` enrichment end-to-end → Task 3 (regression test on `handleTestEnd`).

**Placeholder scan:** every step shows the exact code or assertion. The only conditional language ("if the URL suffix differs in that test, change the assertion to match") refers to aligning with a known-good existing test in the same repo, with the file and approximate line cited — it is a verification step, not an unspecified design decision.

**Type consistency:**

- `isReusablePassingImage(image: Images): boolean` — signature unchanged from the existing function; only the body narrows. Callers in `hasReusablePassingImages` and `preservePreviousPassingImages` are unaffected.
- `preservePreviousPassingImages` return type is unchanged (`Partial<Record<string, Images>>`); the new object literal `{ expect, source: 'baseline-only' }` is a valid `Images`.
- Task 3 reuses `createServerApp` and `app.handleWebSocketMessage` exactly as the existing `describe('declared-only baseline enrichment', ...)` block at `tests/server-routes.test.ts:1064` does. No new helper is introduced; the only difference is the two-cycle `test-begin`/`test-end` sequence and the assertion that `actual` is undefined after the passed cycle.

**Risk to existing behavior:**

- The pre-existing `tests/report-state.test.ts:67-124` test ("keeps carry-forward only for image names still present in a later passing run") uses `baseline-only` inputs and asserts only on `source` and `expect`. It continues to pass under both Task 1 (still reusable) and Task 2 (still preserves `expect` and `source: 'baseline-only'`).
- CI-mode behavior is unchanged: passed comparisons that did emit attachments still flow through `mergeDeclaredImages` and overwrite the carried-forward image (via the existing `isCurrentArtifact` short-circuit at `src/report-state.ts:72`). The change only affects the case where the new run emits **nothing** for a previously-failed visual.
- Live-mode behavior is the fix: the previously-stale `/file/<test-results>/...` URL is replaced by `declared-only` and then enriched to `/baseline/<testId>/<retry>/<visualName>`, which `handleBaseline` in `src/server/artifact-routes.ts:97-132` resolves against the persistent snapshot directory.
