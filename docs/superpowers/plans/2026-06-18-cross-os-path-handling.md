# Cross-OS Absolute Path Handling — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `/file/<encoded-abs-path>` URL generation and decoding deterministic regardless of the host operating system, and surface a clear server-side diagnostic when a foreign-OS path can never resolve locally (e.g. a Windows report opened on macOS).

**Architecture:** Replace the platform-specific `path.isAbsolute` used during URL encoding with a cross-platform helper (`isAnyAbsolutePath`) that recognises both POSIX (`/foo`) and Windows (`C:\foo`, `\\server\share\foo`) absolute paths. On the decode side, `handleFile` keeps using the host's `path.resolve` (because it can only serve files that actually exist locally) but emits a distinct warning when the decoded path looks foreign — so the silent 404 users see today becomes a one-line explanation in the server log and a typed log entry, instead of an unactionable "file not found".

**Tech Stack:** TypeScript, Bun (`bun test`), Node `path` module (`path.win32`, `path.posix`).

**Context:** This is one of two independent plans stemming from the same investigation. The other plan, `2026-06-18-stale-actual-url-on-passing-rerun.md`, fixes the actual reported broken-image symptom (stale `actual` URLs preserved across runs). This plan does **not** make a Linux server able to serve files physically located on a Windows CI runner — that is impossible by construction. It only ensures (a) the URL emitted by the reporter is the same string regardless of which OS generated it, and (b) when a foreign-OS URL is requested, the failure mode is a single diagnostic line rather than a silent 404 indistinguishable from "missing file".

The cross-OS scenario surfaced during investigation turned out **not** to be the user's reproduced bug (that was the stale-URL issue), so this plan is defensive. It is still worth landing because the current `path.isAbsolute` check makes URL generation host-dependent, which is wrong on principle and complicates debugging of any future cross-OS artifact-loading report.

---

## File Structure

- `src/path-utils.ts` — **create.** Pure helpers with no side effects: `isAnyAbsolutePath(p)` recognises POSIX and Windows absolute forms; `isForeignAbsolutePath(p, hostPlatform)` is `true` when `p` is absolute on some platform but not on the host. Host platform is injected (not read from `process.platform` inside the helper) so the functions stay pure and testable.
- `src/report-utils.ts` — **modify.** Replace the `isAbsolute` import from `node:path` with the new `isAnyAbsolutePath` from `./path-utils.ts`. One call site in `attachmentsToImages`.
- `src/server/artifact-routes.ts` — **modify.** `handleFile` keeps its current resolution strategy but, when `realpathOrNull` returns `null`, checks `isForeignAbsolutePath(decodedPath, process.platform)` and logs a distinct warning before returning 404. No behavioural change to the response.
- `tests/path-utils.test.ts` — **create.** Unit tests for both helpers covering POSIX, Windows drive, UNC, and relative inputs across both host platforms.
- `tests/report-utils.test.ts` — **modify.** Add a test proving a Windows drive path is routed to `/file/<encoded>` on a POSIX host (would currently fail).
- `tests/server-routes.test.ts` — **modify.** Add a test asserting that a foreign-OS `/file/...` request still returns 404 but does not throw and is logged via the new diagnostic path (asserted through a logged-messages spy, matching the existing logging-test pattern in the repo if present; otherwise via a direct call to a new exported helper).

No schema changes. No reporter changes. The encoding change is a pure function swap; the server change adds a diagnostic branch only.

---

### Task 1: Cross-platform absolute-path detection helper

**Files:**

- Create: `src/path-utils.ts`
- Test: `tests/path-utils.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/path-utils.test.ts`:

```ts
import { describe, expect, test } from 'bun:test'

import { isAnyAbsolutePath, isForeignAbsolutePath } from '../src/path-utils'

describe('isAnyAbsolutePath', () => {
  test('recognises POSIX absolute paths', () => {
    expect(isAnyAbsolutePath('/Users/ki/test.png')).toBe(true)
    expect(isAnyAbsolutePath('/tmp/test.png')).toBe(true)
  })

  test('recognises Windows drive paths', () => {
    expect(isAnyAbsolutePath('C:\\work-projects\\test.png')).toBe(true)
    expect(isAnyAbsolutePath('D:/photos/x.png')).toBe(true)
  })

  test('recognises UNC paths', () => {
    expect(isAnyAbsolutePath('\\\\server\\share\\test.png')).toBe(true)
  })

  test('rejects relative paths', () => {
    expect(isAnyAbsolutePath('test-results/x.png')).toBe(false)
    expect(isAnyAbsolutePath('./screenshots/x.png')).toBe(false)
    expect(isAnyAbsolutePath('')).toBe(false)
  })
})

describe('isForeignAbsolutePath', () => {
  test('POSIX path is foreign on Windows host', () => {
    expect(isForeignAbsolutePath('/Users/ki/test.png', 'win32')).toBe(true)
  })

  test('Windows drive path is foreign on POSIX host', () => {
    expect(isForeignAbsolutePath('C:\\work\\test.png', 'linux')).toBe(true)
    expect(isForeignAbsolutePath('C:\\work\\test.png', 'darwin')).toBe(true)
  })

  test('same-OS absolute path is not foreign', () => {
    expect(isForeignAbsolutePath('/Users/ki/test.png', 'darwin')).toBe(false)
    expect(isForeignAbsolutePath('/home/u/test.png', 'linux')).toBe(false)
    expect(isForeignAbsolutePath('C:\\work\\test.png', 'win32')).toBe(false)
  })

  test('relative paths are never foreign', () => {
    expect(isForeignAbsolutePath('test-results/x.png', 'darwin')).toBe(false)
    expect(isForeignAbsolutePath('test-results/x.png', 'win32')).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/path-utils.test.ts`
Expected: FAIL — `Cannot find module '../src/path-utils'` or `isAnyAbsolutePath is not a function`.

- [ ] **Step 3: Write minimal implementation**

Create `src/path-utils.ts`:

```ts
import { win32, posix } from 'path'

export function isAnyAbsolutePath(p: string): boolean {
  return posix.isAbsolute(p) || win32.isAbsolute(p)
}

export function isForeignAbsolutePath(p: string, hostPlatform: NodeJS.Platform): boolean {
  if (!isAnyAbsolutePath(p)) return false
  if (hostPlatform === 'win32') return !win32.isAbsolute(p)
  return !posix.isAbsolute(p)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/path-utils.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Lint and commit**

Run: `bun run lint`
Expected: no new errors.

```bash
git add src/path-utils.ts tests/path-utils.test.ts
git commit -m "feat(path-utils): add cross-platform absolute path helpers"
```

---

### Task 2: Route foreign-OS attachments to `/file/` regardless of host OS

**Files:**

- Modify: `src/report-utils.ts` (imports + `attachmentsToImages` lines ~1, 72-74)
- Test: `tests/report-utils.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/report-utils.test.ts`. The file already imports `attachmentsToImages` from `'../src/report-utils'`. Add:

```ts
test('attachmentsToImages routes Windows-style absolute paths to /file on a POSIX host', () => {
  const windowsPath = 'C:\\work-projects\\test-results\\shot-actual.png'
  const images = attachmentsToImages([{ name: 'shot-actual.png', path: windowsPath, contentType: 'image/png' }])
  expect(images['shot']?.actual).toBe(`/file/${encodeURIComponent(windowsPath)}`)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/report-utils.test.ts -t "Windows-style absolute paths"`
Expected: FAIL — on a POSIX host, `path.isAbsolute('C:\\...')` returns `false`, so the URL is currently `/screenshots/C:\work-projects\...` (treated as relative). The test asserts `/file/C%3A%5C...` and will not match.

- [ ] **Step 3: Write minimal implementation**

In `src/report-utils.ts`, replace the `isAbsolute` import from `node:path` with the new helper:

```ts
import { isAnyAbsolutePath } from './path-utils.ts'
```

Remove the existing `import { isAbsolute } from 'path'` line.

Update the call site inside `attachmentsToImages` (currently around line 72):

```ts
const url = isAnyAbsolutePath(attachment.path)
  ? `/file/${encodeURIComponent(attachment.path)}`
  : `${baseUrl}${attachment.path}`
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/report-utils.test.ts`
Expected: PASS — both the existing POSIX test and the new Windows-path test pass.

- [ ] **Step 5: Run the full test suite to verify nothing else regressed**

Run: `bun test`
Expected: all tests pass. The `tests/report-utils.test.ts` "keeps relative paths under the base url" test continues to pass (relative path detection is unchanged).

- [ ] **Step 6: Lint and commit**

Run: `bun run lint`
Expected: no new errors.

```bash
git add src/report-utils.ts tests/report-utils.test.ts
git commit -m "fix(report-utils): route Windows-style absolute paths to /file on any host"
```

---

### Task 3: Server-side diagnostic when `/file/` URL cannot resolve on the host OS

**Files:**

- Modify: `src/server/artifact-routes.ts` (`handleFile` lines ~19-51)
- Test: `tests/server-routes.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/server-routes.test.ts` inside the existing `describe('GET /file', ...)` block (around line 951). The block already imports `join`, `TMP_DIR`, `mkdir`, `writeFile`, `handleHttpRequest`, and `createContext` — reuse them.

```ts
test('returns 404 for a foreign-OS absolute path that cannot resolve locally', async () => {
  const foreignAbs = process.platform === 'win32' ? '/Users/ki/x.png' : 'C:\\Users\\ki\\x.png'
  const ctx = { ...createContext({}), artifactRoots: [TMP_DIR] }

  const res = await handleHttpRequest(ctx, new Request(`http://localhost/file/${encodeURIComponent(foreignAbs)}`))

  expect(res.status).toBe(404)
})
```

This test asserts only the existing 404 contract; the behavioural change in this task is purely additive logging. It exists to guard against a regression where the diagnostic branch accidentally throws or returns a different status.

- [ ] **Step 2: Run test to verify it passes (no implementation change yet)**

Run: `bun test tests/server-routes.test.ts -t "foreign-OS absolute path"`
Expected: PASS — `realpathOrNull` already returns `null` for the foreign path, `handleFile` already returns 404.

- [ ] **Step 3: Add diagnostic logging**

In `src/server/artifact-routes.ts`, extend the imports at the top:

```ts
import { existsSync } from 'fs'
import { realpath } from 'fs/promises'
import { dirname, resolve } from 'path'

import { isForeignAbsolutePath } from '../path-utils.ts'
import { resolveBaselineTargets } from '../snapshot-path-resolver.ts'
import type { TestData } from '../types.ts'
import { respondWithFile } from './file-utils.ts'
import type { RoutesContext } from './routes.ts'
import { isPathWithinRoots } from './utils.ts'
```

Update `handleFile` to log a distinct diagnostic when the path looks foreign. The 404 response is unchanged:

```ts
export async function handleFile(ctx: RoutesContext, req: Request): Promise<Response> {
  const notFound = (): Response => new Response('Not Found', { status: 404 })

  let decodedPath: string
  try {
    decodedPath = resolve(decodeURIComponent(new URL(req.url).pathname.slice('/file/'.length)))
  } catch {
    return notFound()
  }

  const realTarget = await realpathOrNull(decodedPath)
  if (realTarget === null) {
    if (isForeignAbsolutePath(decodedPath, process.platform)) {
      console.warn(
        `[Crvy Rprtr] /file request resolved to a foreign-OS absolute path that cannot be served on ${process.platform}: ${decodedPath}`,
      )
    }
    return notFound()
  }

  const realRoots = (await Promise.all((ctx.artifactRoots ?? []).map((root) => realpathOrNull(resolve(root))))).filter(
    (root): root is string => root !== null,
  )

  if (!isPathWithinRoots(realTarget, realRoots)) {
    return notFound()
  }

  try {
    const file = await respondWithFile(realTarget)
    return file ?? notFound()
  } catch {
    return notFound()
  }
}
```

- [ ] **Step 4: Run test to verify it still passes**

Run: `bun test tests/server-routes.test.ts`
Expected: PASS — all existing `/file` tests still pass, plus the new foreign-path test.

- [ ] **Step 5: Lint and commit**

Run: `bun run lint`
Expected: no new errors.

```bash
git add src/server/artifact-routes.ts tests/server-routes.test.ts
git commit -m "feat(server): log diagnostic when /file URL cannot resolve on host OS"
```

---

### Task 4: README note on cross-OS artifact loading

**Files:**

- Modify: `README.md` (the "Offline Mode" or a new short subsection near it)

- [ ] **Step 1: Append a clarifying paragraph**

In `README.md`, after the existing "Passed Screenshot Modes" section (around line 110), add a new subsection:

```markdown
## Cross-OS Artifact Loading

Crvy Rprtr stores image URLs exactly as the reporter that produced them saw them. In live mode (server running during the test run), failure artifacts are referenced by absolute path under `/file/<encoded>`; in CI/offline mode, attachments are copied into `screenshots/` and referenced by relative path under `/screenshots/`.

If you generate a report on one operating system and then open it on another (for example, downloading a Windows CI runner's `report.json` onto a macOS laptop), absolute-path `/file/...` URLs cannot resolve: the file is not on your filesystem. Crvy Rprtr logs a single diagnostic line per such request and returns 404. The `/screenshots/...` and `/baseline/...` URLs remain portable because they resolve through the server's `screenshotDir` or snapshot resolver.

For fully portable artifact loading across operating systems, run the reporter in CI mode (`ci: true`) and ship the `screenshots/` directory alongside the report JSON.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: document cross-OS artifact loading limitations"
```

---

## Self-Review

**Spec coverage:**

- Cross-platform URL encoding → Task 2 (replaces `path.isAbsolute`).
- Server-side diagnostic for foreign paths → Task 3.
- Documentation of the limitation → Task 4.
- The fix does **not** attempt to make a foreign-OS file loadable; it makes the failure diagnosable and the encoding deterministic. This is intentional and called out in the plan header.

**Placeholder scan:** no TBD/TODO/«implement later» markers. Every step shows the exact code or text to add.

**Type consistency:**

- `isAnyAbsolutePath(p: string): boolean` — defined in Task 1, used in Task 2 with identical signature.
- `isForeignAbsolutePath(p: string, hostPlatform: NodeJS.Platform): boolean` — defined in Task 1, used in Task 3 with `process.platform` as the second argument. `process.platform` is typed as `NodeJS.Platform`, so the call type-checks.

**Risk to existing behavior:** the only behavioral change is in Task 2: a Windows-style absolute path is now encoded as `/file/...` even on POSIX hosts (previously it was wrongly encoded as `/screenshots/...`). The existing `tests/report-utils.test.ts` POSIX-path and relative-path tests continue to pass. No reporter payload schema changes; only the URL string differs for a path shape that was previously misrouted.
