# Stuck-Pending Run Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a UI-triggered run produces no test events, revert the optimistically-marked-pending tests to their pre-run status and show an inline message, instead of leaving the tree orphaned on "pending".

**Architecture:** Pure, `bun:test`-coverable helpers (`captureTestStatuses` / `restoreTestStatuses`) own the snapshot/restore logic. `App.svelte` captures a snapshot before marking pending, records which test ids received events during the run, and on `run-status: { running: false }` restores any snapshotted test that received no event. No server change, no schema change, no new WebSocket message type.

**Tech Stack:** TypeScript, Svelte 5 (runes), Bun (`bun:test`), `oxlint`, `tsc`. The client has no Svelte unit-test harness, so deterministic coverage lives in the pure helper; the `App.svelte` wiring is verified by typecheck + lint + manual repro (consistent with the prior run-from-UI specs).

**Spec:** `docs/superpowers/specs/2026-07-03-stuck-pending-run-recovery-design.md`

---

## File Structure

- **Create** `src/client/helpers/run-snapshot.ts` — two pure tree-walking functions: `captureTestStatuses` (snapshot `id → status` under a node) and `restoreTestStatuses` (restore status for snapshotted ids that received no event). No Svelte, no globals; directly unit-testable.
- **Create** `tests/run-snapshot.test.ts` — `bun:test` unit tests for both helpers, including a `restoreTestStatuses` + `recalcAllSuiteStatuses` rollup assertion.
- **Modify** `src/client/App.svelte` — add snapshot/event-id bookkeeping, a `finalizeRunSnapshot()` orchestrator, unify the run entry point (`handleStart(filters, target)`), and split the `run-status` WebSocket case into start/finish branches.

The helper is the single new module; the component only records ids and calls the helper. Files that change together (the run lifecycle) live together in `App.svelte`; the reusable, testable logic is extracted into `helpers/`.

---

## Task 1: Add `captureTestStatuses` / `restoreTestStatuses` helpers (TDD)

**Files:**

- Create: `tests/run-snapshot.test.ts`
- Create: `src/client/helpers/run-snapshot.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/run-snapshot.test.ts`:

```ts
import { describe, expect, test } from 'bun:test'
import type { CrvyRprtrSuite, CrvyRprtrTest, TestStatus } from '../src/types'
import { captureTestStatuses, restoreTestStatuses } from '../src/client/helpers/run-snapshot'
import { recalcAllSuiteStatuses } from '../src/client/helpers/suite'

function makeTest(id: string, status: TestStatus | undefined): CrvyRprtrTest {
  return { id, titlePath: [], browser: 'chromium', title: id, status, checked: true }
}

function makeSuite(children: CrvyRprtrSuite['children']): CrvyRprtrSuite {
  return { path: [], skip: false, opened: false, checked: true, indeterminate: false, children }
}

describe('captureTestStatuses', () => {
  test('captures id -> status for every descendant test', () => {
    const tree = makeSuite({
      a: makeTest('a', 'failed'),
      group: makeSuite({
        b: makeTest('b', 'success'),
      }),
    })
    const snapshot = captureTestStatuses(tree)
    expect(snapshot.get('a')).toBe('failed')
    expect(snapshot.get('b')).toBe('success')
    expect(snapshot.size).toBe(2)
  })

  test('is scoped to the given subtree', () => {
    const target = makeSuite({
      group: makeSuite({ a: makeTest('a', 'failed') }),
    })
    const tree = makeSuite({ other: makeTest('other', 'success'), target })
    const snapshot = captureTestStatuses(target)
    expect(snapshot.has('a')).toBe(true)
    expect(snapshot.has('other')).toBe(false)
  })

  test('captures undefined status as undefined', () => {
    const tree = makeSuite({ a: makeTest('a', undefined) })
    const snapshot = captureTestStatuses(tree)
    expect(snapshot.has('a')).toBe(true)
    expect(snapshot.get('a')).toBeUndefined()
  })
})

describe('restoreTestStatuses', () => {
  test('restores only ids not in receivedIds and returns the count', () => {
    const testA = makeTest('a', 'pending')
    const testB = makeTest('b', 'pending')
    const tree = makeSuite({ a: testA, b: testB })
    const snapshot = new Map<string, TestStatus | undefined>([
      ['a', 'failed'],
      ['b', 'success'],
    ])
    const restored = restoreTestStatuses(tree, snapshot, new Set(['b']))
    expect(restored).toBe(1)
    expect(testA.status).toBe('failed')
    expect(testB.status).toBe('pending')
  })

  test('walks nested suites', () => {
    const inner = makeTest('inner', 'pending')
    const tree = makeSuite({ group: makeSuite({ inner }) })
    const snapshot = new Map<string, TestStatus | undefined>([['inner', 'approved']])
    expect(restoreTestStatuses(tree, snapshot, new Set())).toBe(1)
    expect(inner.status).toBe('approved')
  })

  test('restore then recalcAllSuiteStatuses yields the correct parent rollup', () => {
    const testA = makeTest('a', 'pending')
    const testB = makeTest('b', 'success')
    const group = makeSuite({ a: testA, b: testB })
    const tree = makeSuite({ group })
    const snapshot = new Map<string, TestStatus | undefined>([['a', 'failed']])
    restoreTestStatuses(tree, snapshot, new Set(['b']))
    recalcAllSuiteStatuses(tree)
    // 'a' reverted to failed, 'b' untouched (success); suite rolls up to failed
    expect(group.status).toBe('failed')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/run-snapshot.test.ts`
Expected: FAIL — error resolving `../src/client/helpers/run-snapshot` (module does not exist).

- [ ] **Step 3: Write the minimal implementation**

Create `src/client/helpers/run-snapshot.ts`:

```ts
import { type CrvyRprtrSuite, type CrvyRprtrTest, type TestStatus, isTest, getChildrenArray } from '../../types'

/** Captures testId -> current status for every test under `node` (including `undefined`). */
export function captureTestStatuses(node: CrvyRprtrSuite | CrvyRprtrTest): Map<string, TestStatus | undefined> {
  const snapshot = new Map<string, TestStatus | undefined>()
  const walk = (n: CrvyRprtrSuite | CrvyRprtrTest): void => {
    if (isTest(n)) {
      snapshot.set(n.id, n.status)
      return
    }
    for (const child of getChildrenArray(n.children)) walk(child)
  }
  walk(node)
  return snapshot
}

/**
 * Restores `test.status` for every test under `root` whose id is in `snapshot`
 * and NOT in `receivedIds`. Leaves tests that did receive an event untouched.
 * Returns the number of tests restored.
 */
export function restoreTestStatuses(
  root: CrvyRprtrSuite,
  snapshot: Map<string, TestStatus | undefined>,
  receivedIds: Set<string>,
): number {
  let restored = 0
  const walk = (n: CrvyRprtrSuite | CrvyRprtrTest): void => {
    if (isTest(n)) {
      if (snapshot.has(n.id) && !receivedIds.has(n.id)) {
        n.status = snapshot.get(n.id)
        restored++
      }
      return
    }
    for (const child of getChildrenArray(n.children)) walk(child)
  }
  walk(root)
  return restored
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test tests/run-snapshot.test.ts`
Expected: PASS — 6 tests, 0 fail.

- [ ] **Step 5: Run typecheck and lint on the new files**

Run: `bun run typecheck`
Expected: PASS (no errors).

Run: `bun run lint`
Expected: PASS (no errors).

- [ ] **Step 6: Commit**

```bash
git add src/client/helpers/run-snapshot.ts tests/run-snapshot.test.ts
git commit -m "feat(client): add captureTestStatuses/restoreTestStatuses helpers"
```

---

## Task 2: Wire the recovery into `App.svelte`

**Files:**

- Modify: `src/client/App.svelte`

There is no Svelte unit-test harness in this project (accepted project-wide; the deterministic recovery logic is covered by Task 1's helper tests). This task is verified by typecheck + lint + the manual repro in Task 3.

- [ ] **Step 1: Add the `TestStatus` type import**

In `src/client/App.svelte`, find the existing type import from `'../types'` for the suite/test types (the line importing `CrvyRprtrSuite, CrvyRprtrTest, ImagesViewMode`) and add `type TestStatus`:

oldString:

```ts
import type { CrvyRprtrSuite, CrvyRprtrTest, ImagesViewMode } from '../types'
```

newString:

```ts
import type { CrvyRprtrSuite, CrvyRprtrTest, ImagesViewMode, TestStatus } from '../types'
```

- [ ] **Step 2: Add the helper import**

Immediately after the existing `from './helpers'` import block (the multi-line import ending with `type CrvyRprtrViewFilter`), add a new import line:

oldString:

```ts
    type CrvyRprtrViewFilter,
  } from './helpers';
```

newString:

```ts
    type CrvyRprtrViewFilter,
  } from './helpers';
  import { captureTestStatuses, restoreTestStatuses } from './helpers/run-snapshot';
```

- [ ] **Step 3: Add snapshot bookkeeping state**

Find the existing `runMessage` state declaration and add the two run-lifecycle bookkeeping variables after it (plain `let`, not `$state` — nothing renders off these directly; the rendered tree reactively updates through the `$state(tests)` deep proxy when statuses are restored in place):

oldString:

```ts
let runMessage = $state<string | null>(null)
```

newString:

```ts
let runMessage = $state<string | null>(null)
let runSnapshot: Map<string, TestStatus | undefined> | null = null
let runEventIds: Set<string> = new Set()
```

- [ ] **Step 4: Rewrite `handleStart` to capture, guard via snapshot, and restore on 409/400**

Replace the entire `handleStart` function. The signature gains a `target` param (the node to snapshot and mark pending — defaults to the `tests` root for run-all). The guard now also rejects when a snapshot is already active (`runSnapshot !== null`), which closes the double-click/cross-tab race synchronously without touching `isRunning`.

oldString:

```ts
async function handleStart(filters?: RunFilters): Promise<void> {
  if (isRunning) {
    runMessage = 'A run is already in progress'
    return
  }
  if (!filters || !filters.tests) {
    markTestsPending(tests)
    recalcAllSuiteStatuses(tests)
  }
  const res = await fetch('/api/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(filters ?? {}),
  })
  if (res.status === 409 || res.status === 400) {
    const body = (await res.json().catch(() => null)) as { reason?: string } | null
    runMessage =
      body?.reason === 'already-running'
        ? 'A run is already in progress'
        : body?.reason === 'no-tests'
          ? 'No tests selected'
          : 'Connect a Playwright reporter to enable running'
  }
}
```

newString:

```ts
async function handleStart(filters?: RunFilters, target?: CrvyRprtrSuite | CrvyRprtrTest): Promise<void> {
  if (isRunning || runSnapshot !== null) {
    runMessage = 'A run is already in progress'
    return
  }
  const markTarget = target ?? tests
  runSnapshot = captureTestStatuses(markTarget)
  runEventIds = new Set()
  markTestsPending(markTarget)
  recalcAllSuiteStatuses(tests)
  const res = await fetch('/api/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(filters ?? {}),
  })
  if (res.status === 409 || res.status === 400) {
    if (runSnapshot !== null) {
      restoreTestStatuses(tests, runSnapshot, runEventIds)
      recalcAllSuiteStatuses(tests)
      runSnapshot = null
    }
    const body = (await res.json().catch(() => null)) as { reason?: string } | null
    runMessage =
      body?.reason === 'already-running'
        ? 'A run is already in progress'
        : body?.reason === 'no-tests'
          ? 'No tests selected'
          : 'Connect a Playwright reporter to enable running'
  }
}

function finalizeRunSnapshot(): void {
  if (runSnapshot === null) return
  restoreTestStatuses(tests, runSnapshot, runEventIds)
  recalcAllSuiteStatuses(tests)
  if (runEventIds.size === 0) {
    runMessage = 'Run produced no results — see the server terminal for details.'
  }
  runSnapshot = null
  runEventIds = new Set()
}
```

- [ ] **Step 5: Simplify `handleRunItem` to delegate marking to `handleStart`**

`handleRunItem` no longer marks pending itself — `handleStart` now owns snapshot+mark for both paths. It just builds descriptors and delegates, passing the item as the snapshot target.

oldString:

```ts
function handleRunItem(item: CrvyRprtrSuite | CrvyRprtrTest): void {
  const descriptors = (isTest(item) ? [item] : getAllTests(item))
    .map(toDescriptor)
    .filter((d): d is RunTestDescriptor => d !== null)

  if (descriptors.length === 0) {
    runMessage = 'Cannot run: no source location for the selected test(s)'
    return
  }
  markTestsPending(item)
  recalcAllSuiteStatuses(tests)
  handleStart({ tests: descriptors })
}
```

newString:

```ts
function handleRunItem(item: CrvyRprtrSuite | CrvyRprtrTest): void {
  const descriptors = (isTest(item) ? [item] : getAllTests(item))
    .map(toDescriptor)
    .filter((d): d is RunTestDescriptor => d !== null)

  if (descriptors.length === 0) {
    runMessage = 'Cannot run: no source location for the selected test(s)'
    return
  }
  handleStart({ tests: descriptors }, item)
}
```

- [ ] **Step 6: Record received event ids in the `test-begin` / `test-update` WebSocket cases**

In the `applyClientMessage` switch inside the WebSocket `$effect`, add id recording after the existing `syncTreeState` call for both event types:

oldString:

```ts
        case 'test-begin':
        case 'test-update': {
          const current = collectTestsById(tests);
          current[msg.data.id] = msg.data;
          syncTreeState(tests, current);
          break;
        }
```

newString:

```ts
        case 'test-begin':
        case 'test-update': {
          const current = collectTestsById(tests);
          current[msg.data.id] = msg.data;
          syncTreeState(tests, current);
          if (runSnapshot !== null) runEventIds.add(msg.data.id);
          break;
        }
```

- [ ] **Step 7: Split the `run-status` WebSocket case into start/finish**

Replace the blanket `runMessage = null` clear with branched behavior: a new run (`running: true`) clears the stale message; run end (`running: false`) runs the snapshot finalizer (which restores orphaned pending and may set the "no results" message).

oldString:

```ts
        case 'run-status': {
          isRunning = msg.data.running;
          runMessage = null;
          break;
        }
```

newString:

```ts
        case 'run-status': {
          if (msg.data.running) {
            isRunning = true;
            runMessage = null;
          } else {
            isRunning = false;
            finalizeRunSnapshot();
          }
          break;
        }
```

- [ ] **Step 8: Run typecheck**

Run: `bun run typecheck`
Expected: PASS (no errors). Note: `tsc` does not inspect `.svelte` interiors, so this mainly guards the helper module and any `.ts` reachability; the Svelte edits are covered by lint + manual verification.

- [ ] **Step 9: Run lint**

Run: `bun run lint`
Expected: PASS (no errors).

- [ ] **Step 10: Run the full bun test suite to confirm no regressions**

Run: `bun test tests/run-snapshot.test.ts tests/run-controller.test.ts`
Expected: PASS — both files, 0 fail.

- [ ] **Step 11: Commit**

```bash
git add src/client/App.svelte
git commit -m "feat(client): revert orphaned pending on no-event run"
```

---

## Task 3: Manual verification (no client test harness)

**Files:** none (verification only)

The client has no Svelte unit-test harness; the recovery logic is covered by Task 1's helper tests, and the wiring is verified manually here, consistent with the prior run-from-UI specs.

- [ ] **Step 1: Start the dev server**

Run: `bun run dev`
Open http://localhost:3000 in two browser tabs. Confirm the ▶ Start button is visible (the server auto-discovers `playwright.config.ts`, so `runEnabled` is true).

- [ ] **Step 2: Verify the cross-tab 409 restore (non-destructive)**

1. In Tab 1, click ▶ Start. The tree flips to pending; the button becomes ■.
2. Quickly in Tab 2, click ▶ Start. The server returns `409 already-running`.
3. **Expected:** Tab 2's tree reverts to its pre-click statuses (not stuck pending) and the inline message reads "A run is already in progress."
4. Let Tab 1's run finish (or click ■ Stop in Tab 1). Both tabs return to ▶.

- [ ] **Step 3: Verify the no-event revert + message**

This repro forces a run that produces zero test events by making Playwright fail to load its config:

1. Temporarily introduce a load-time error in `playwright.config.ts` (e.g., add `throw new Error('boom')` at the top level, or import a nonexistent module). Note: this only affects the spawned child's config load; the server itself is unaffected.
2. In the browser, note the current test statuses, then click ▶ Start.
3. **Expected:** the tree flips to pending briefly, then the spawned child exits without producing any test events; the tree reverts to the pre-run statuses and the inline message reads "Run produced no results — see the server terminal for details."
4. Click ▶ Start again (or fix the config and run). **Expected:** the message clears on the next run start.
5. Revert `playwright.config.ts` to its original state.

- [ ] **Step 4: Verify a normal successful run is unaffected**

1. With a valid config, click ▶ Start.
2. **Expected:** tests stream `test-begin`/`test-end` as usual; the tree updates to real statuses; no "no results" message appears; the snapshot is cleared afterwards (a subsequent run starts clean).

---

## Self-Review

**Spec coverage:**

- D1 (client-owned snapshot/revert) → Task 1 helper + Task 2 wiring. ✓
- D2 (per-test revert keyed on received ids) → `restoreTestStatuses` skips `receivedIds`; Task 1 test "restores only ids not in receivedIds". ✓
- D3 (race closed via `runSnapshot !== null`) → Task 2 Step 4 guard `isRunning || runSnapshot !== null`. ✓
- D4 (message only on total failure; persists until next run) → Task 2 Step 7 `runEventIds.size === 0` sets message; `running: true` clears it. ✓
- Pure helper extracted + `bun:test` covered → Task 1. ✓
- Unified `handleStart(filters, target)` entry point → Task 2 Step 4 + Step 5. ✓
- Edge cases table (409, 400, partial, successful, empty-state, not-initiated) → wiring + Task 3 manual repros. ✓

**Placeholder scan:** None. Every code step contains complete, runnable code with exact `oldString`/`newString` blocks.

**Type consistency:**

- `captureTestStatuses` returns `Map<string, TestStatus | undefined>` in both the helper (Task 1 Step 3) and its consumer (Task 2 Step 3 `runSnapshot` declaration). ✓
- `restoreTestStatuses(root, snapshot, receivedIds)` signature matches across helper, Task 1 tests, and Task 2 Step 4 (`handleStart` 409 path) + `finalizeRunSnapshot`. ✓
- `handleStart(filters?, target?)` signature in Step 4 matches the call in Step 5 (`handleStart({ tests: descriptors }, item)`). ✓
- `finalizeRunSnapshot` defined in Step 4, called in Step 7. ✓
- `runEventIds.add(msg.data.id)` — `msg.data.id` is `string` (`TestData.id`) for `test-begin`/`test-update`; `runEventIds` is `Set<string>`. ✓

No issues found.
