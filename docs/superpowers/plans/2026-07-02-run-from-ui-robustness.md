# Run-From-UI Robustness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden the run-from-UI feature so spawned runs use the project's package manager, always load `@crvy/rprtr`, never hang on a co-configured HTML reporter, scope large suites without hitting command-line limits, and give feedback when a run cannot be scoped.

**Architecture:** Server-side `RunController` resolves the launch command via `package-manager-detector`, always injects `--reporter` resolved from the project cwd then the server's own module, and translates a new descriptor-based `{ tests: [...] }` filter into either precise positional args (single test / old Playwright) or a `--test-list` temp file (suites on Playwright ≥1.56). The client builds descriptors from the tree and surfaces a message when none can be built.

**Tech Stack:** TypeScript, Bun, `package-manager-detector`, zod, Svelte 5, `bun:test`.

**Spec:** `docs/superpowers/specs/2026-07-02-run-from-ui-robustness-design.md`

---

## File Structure

**Modify:**

- `package.json` — add `package-manager-detector` dependency.
- `src/schemas/http.ts` — replace `RunRequestBodySchema` with descriptor-based model; add `RunTestDescriptorSchema`; extend `RunResponseSchema` with `'no-tests'`.
- `src/server/run-controller.ts` — PM-aware launcher, robust reporter resolution, descriptor translation, `--test-list` path, version detection, temp-file lifecycle, `'no-tests'` reason.
- `src/server/run-routes.ts` — return 400 (not 409) for `'no-tests'`.
- `src/client/App.svelte` — descriptor-based `RunFilters`/`handleRunItem`, `isRunning` guard, no-location feedback.
- `tests/run-controller.test.ts` — update launcher/reporter/filter assertions; add PM, test-list, version, temp-file tests.
- `tests/server-routes.test.ts` — migrate `{ files, project }` tests to `{ tests }`; add 400 no-tests test.

**Create:**

- `tests/fixtures/playwright-list-sample.txt` — captured `playwright test --list` output for entry-format validation.

---

## Task 1: Add `package-manager-detector` and PM-aware launcher (#1)

**Files:**

- Modify: `package.json`
- Modify: `src/server/run-controller.ts` (replace `resolveBin` at line 53 and its use in `start` at line 95-108)
- Modify: `tests/run-controller.test.ts` (launcher assertions)

### Step 1: Add the dependency

- [ ] Run: `bun add package-manager-detector`
- [ ] Verify `package.json` `dependencies` now contains `"package-manager-detector"`.

### Step 2: Write the failing test for a PM-resolved launch

In `tests/run-controller.test.ts`, extend the `RunControllerDeps` stub inside `createFixture` to accept an injectable launcher. First add a field to the `Fixture` interface and the deps:

- [ ] Add to the `Fixture` interface (after `spawnCalls`):

```ts
setResolveLaunch: (fn: ((cwd: string, args: string[]) => { cmd: string; args: string[] }) | null) => void
```

- [ ] Inside `createFixture`, add a mutable launcher and wire it into `deps`:

```ts
let resolveLaunch: ((cwd: string, args: string[]) => { cmd: string; args: string[] }) | null = null
```

and inside the `deps` object add:

```ts
resolveLaunch: ((cwd: string, args: string[]) => resolveLaunch?.(cwd, args) ?? { cmd: 'npx', args: ['playwright', ...args] }),
```

and the returned fixture object add:

```ts
setResolveLaunch: (fn): void => {
  resolveLaunch = fn
},
```

- [ ] Add the test in the `describe('RunController.start', ...)` block:

```ts
test('uses the injected package-manager launcher when provided', () => {
  const f = createFixture(SAMPLE_CTX)
  f.setResolveLaunch((_cwd, args) => ({ cmd: 'pnpm', args: ['exec', 'playwright', ...args] }))
  f.controller.start({})
  expect(f.spawnCalls[0]!.cmd).toBe('pnpm')
  expect(f.spawnCalls[0]!.args).toEqual(['exec', 'playwright', 'test', '--config', '/proj/playwright.config.ts'])
})
```

### Step 3: Run the test to verify it fails

- [ ] Run: `cd tests && bun test run-controller.test.ts`
- [ ] Expected: FAIL — `resolveLaunch` is not yet read by `RunController`; spawn still uses `npx`/`playwright` split, so `cmd` is `'npx'` not `'pnpm'`.

### Step 4: Implement the PM-aware launcher and wire it into `RunController`

- [ ] In `src/server/run-controller.ts`, add the import and replace `resolveBin`:

```ts
import { detectSync, getUserAgent } from 'package-manager-detector/detect'
import { resolveCommand } from 'package-manager-detector/commands'
```

Replace the `resolveBin` function (line 53-55) with:

```ts
export function resolvePlaywrightLaunch(cwd: string, playwrightArgs: string[]): { cmd: string; args: string[] } {
  const agent = detectSync({ cwd })?.agent ?? getUserAgent()
  const resolved = agent !== null ? resolveCommand(agent, 'execute-local', ['playwright', ...playwrightArgs]) : null
  if (resolved !== null) return { cmd: resolved.command, args: resolved.args }
  return { cmd: 'npx', args: ['playwright', ...playwrightArgs] }
}
```

- [ ] Add `resolveLaunch` to `RunControllerDeps` (after `resolveReporter?`):

```ts
resolveLaunch?: (cwd: string, playwrightArgs: string[]) => { cmd: string; args: string[] }
```

- [ ] In `start()`, replace the lines that build `cmd`/`argsPrefix` (currently `const { cmd, argsPrefix } = resolveBin(ctx.cwd)` and `const args = [...argsPrefix, ...toArgs(...)]`). The reporter injection stays for now (Task 2 rewrites `resolveReporterModule`). Replace the launch resolution with:

```ts
const resolveLaunch = this.deps.resolveLaunch ?? resolvePlaywrightLaunch
const playwrightArgs = toArgs(filters, ctx.configFile, reporterModule)
const { cmd, args } = resolveLaunch(ctx.cwd, playwrightArgs)
```

(Leave the existing `spawn(cmd, args, { cwd, env, stdio })` call and the `toArgs`/`resolveReporterModule` functions unchanged for this task — only the bin resolution changes.)

### Step 5: Run all run-controller tests to verify they pass

- [ ] Run: `cd tests && bun test run-controller.test.ts`
- [ ] Expected: PASS. The existing happy-path test still sees `cmd === 'npx'` because the test environment has no detectable package manager (fallback), and the new injected-launcher test sees `pnpm`.

### Step 6: Commit

- [ ] Run:

```bash
git add package.json bun.lock src/server/run-controller.ts tests/run-controller.test.ts
git commit -m "feat(run-controller): resolve playwright via project package manager"
```

---

## Task 2: Robust reporter resolution (#2)

**Files:**

- Modify: `src/server/run-controller.ts` (replace `resolveReporterModule` at line 65-72)
- Modify: `tests/run-controller.test.ts`

### Step 1: Write the failing tests for the fallback chain

- [ ] In `tests/run-controller.test.ts`, add a describe block. The existing `resolveReporter` injection already overrides the default; we test the new default function directly.

```ts
import { resolveReporterDefault } from '../src/server/run-controller'

describe('resolveReporter default', () => {
  test('resolves from the project cwd when installed there', () => {
    // SAMPLE_CTX.cwd is the real repo root where @crvy/rprtr is self-installed.
    expect(resolveReporterDefault(SAMPLE_CTX.cwd)).not.toBeNull()
  })

  test('falls back to the server module location when the project cwd throws', () => {
    // A cwd with no resolvable @crvy/rprtr should still resolve via import.meta.url
    // because the server IS @crvy/rprtr.
    expect(resolveReporterDefault('/nonexistent/project/path')).not.toBeNull()
  })
})
```

### Step 2: Run the test to verify it fails

- [ ] Run: `cd tests && bun test run-controller.test.ts`
- [ ] Expected: FAIL — `resolveReporterDefault` is not exported yet.

### Step 3: Implement the robust resolver

- [ ] In `src/server/run-controller.ts`, replace `resolveReporterModule` (line 65-72) with:

```ts
export function resolveReporterDefault(cwd: string): string | null {
  try {
    return createRequire(join(cwd, 'package.json')).resolve('@crvy/rprtr')
  } catch {
    // Not installed in the project; fall through to the server's own package.
  }
  try {
    return createRequire(import.meta.url).resolve('@crvy/rprtr')
  } catch {
    return null
  }
}
```

- [ ] Update the default in `start()`: change `const resolveReporter = this.deps.resolveReporter ?? resolveReporterModule` to `?? resolveReporterDefault`. Delete the old `resolveReporterModule` function.

### Step 4: Run the tests to verify they pass

- [ ] Run: `cd tests && bun test run-controller.test.ts`
- [ ] Expected: PASS. The existing "adds --reporter when resolveReporter returns a path" and "omits --reporter when resolveReporter returns null" tests still pass (they inject `resolveReporter` directly); the two new default-resolver tests pass.

### Step 5: Commit

- [ ] Run:

```bash
git add src/server/run-controller.ts tests/run-controller.test.ts
git commit -m "fix(run-controller): resolve @crvy/rprtr from project cwd then server module"
```

---

## Task 3: Descriptor schema + positional translation + no-tests (#5 positional, #6 fallback, server)

This task migrates the server to the descriptor-based protocol. Suite runs use positional args here; the `--test-list` branch is added in Task 4.

**Files:**

- Modify: `src/schemas/http.ts`
- Modify: `src/server/run-controller.ts` (`RunFilters`, `StartResult`, `toArgs`, `start`)
- Modify: `src/server/run-routes.ts` (400 for no-tests)
- Modify: `tests/run-controller.test.ts`
- Modify: `tests/server-routes.test.ts`

### Step 1: Migrate the request/response schemas

- [ ] In `src/schemas/http.ts`, replace `RunRequestBodySchema` (line 12-15) with:

```ts
export const RunTestDescriptorSchema = z.object({
  file: z.string(),
  line: z.number(),
  column: z.number().optional(),
  projectName: z.string().optional(),
  titlePath: z.array(z.string()),
})

export type RunTestDescriptor = z.infer<typeof RunTestDescriptorSchema>

export const RunRequestBodySchema = z.object({
  tests: z.array(RunTestDescriptorSchema).optional(),
})
```

- [ ] In the same file, extend `RunResponseSchema`'s failure reason (line 23) from `z.enum(['no-config', 'already-running'])` to:

```ts
reason: z.enum(['no-config', 'already-running', 'no-tests']),
```

### Step 2: Update `RunFilters` and `StartResult` types

- [ ] In `src/server/run-controller.ts`, replace the `RunFilters` interface (line 12-15) with:

```ts
export interface RunFilters {
  tests?: RunTestDescriptor[]
}
```

Add the import at the top:

```ts
import type { RunTestDescriptor } from '../schemas.ts'
```

- [ ] Extend `StartResult` (line 17):

```ts
export type StartResult = { ok: true } | { ok: false; reason: 'no-config' | 'already-running' | 'no-tests' }
```

### Step 3: Write the failing tests for descriptor translation

- [ ] In `tests/run-controller.test.ts`, replace the three existing positional tests (`'passes files as positional file:line args'`, `'passes project as --project arg'`, `'passes both files and project together'`) with descriptor-based equivalents:

```ts
test('single descriptor becomes positional file:line:column with --project', () => {
  const f = createFixture(SAMPLE_CTX, () => null) // no --reporter, isolate filter args
  f.controller.start({
    tests: [{ file: 'tests/foo.spec.ts', line: 42, column: 11, projectName: 'chromium', titlePath: ['suite', 'foo'] }],
  })
  expect(f.spawnCalls[0]!.args).toEqual([
    'test',
    '--config',
    '/proj/playwright.config.ts',
    '--project',
    'chromium',
    'tests/foo.spec.ts:42:11',
  ])
})

test('multiple descriptors become positional args with shared --project', () => {
  const f = createFixture(SAMPLE_CTX, () => null)
  f.controller.start({
    tests: [
      { file: 'a.spec.ts', line: 1, projectName: 'chromium', titlePath: ['t1'] },
      { file: 'b.spec.ts', line: 2, column: 3, projectName: 'chromium', titlePath: ['t2'] },
    ],
  })
  expect(f.spawnCalls[0]!.args).toEqual([
    'test',
    '--config',
    '/proj/playwright.config.ts',
    '--project',
    'chromium',
    'a.spec.ts:1',
    'b.spec.ts:2:3',
  ])
})

test('multiple descriptors with mixed projects omit --project', () => {
  const f = createFixture(SAMPLE_CTX, () => null)
  f.controller.start({
    tests: [
      { file: 'a.spec.ts', line: 1, projectName: 'chromium', titlePath: ['t1'] },
      { file: 'b.spec.ts', line: 2, projectName: 'firefox', titlePath: ['t2'] },
    ],
  })
  expect(f.spawnCalls[0]!.args).toEqual([
    'test',
    '--config',
    '/proj/playwright.config.ts',
    'a.spec.ts:1',
    'b.spec.ts:2',
  ])
})

test('empty tests array returns no-tests without spawning', () => {
  const f = createFixture(SAMPLE_CTX)
  const result = f.controller.start({ tests: [] })
  expect(result).toEqual({ ok: false, reason: 'no-tests' })
  expect(f.spawnCalls).toHaveLength(0)
  expect(f.broadcasts).toHaveLength(0)
})
```

Also update the existing `run scope signaling` tests: `filters.files`/`filters.project` no longer exist. Replace the three tests in `describe('RunController.start run scope signaling', ...)` with:

```ts
test('signals an unfiltered run when tests is absent', () => {
  const f = createFixture(SAMPLE_CTX)
  f.controller.start({})
  expect(f.filteredCalls).toEqual([false])
})

test('signals a filtered run when tests is provided', () => {
  const f = createFixture(SAMPLE_CTX)
  f.controller.start({ tests: [{ file: 'a.spec.ts', line: 1, titlePath: ['t'] }] })
  expect(f.filteredCalls).toEqual([true])
})
```

### Step 4: Run the tests to verify they fail

- [ ] Run: `cd tests && bun test run-controller.test.ts`
- [ ] Expected: FAIL — `toArgs` still reads `filters.files`/`filters.project`.

### Step 5: Rewrite the translation

- [ ] In `src/server/run-controller.ts`, replace `toArgs` (line 57-63) with descriptor-aware helpers:

```ts
function descriptorLocation(d: RunTestDescriptor): string {
  return d.column === undefined ? `${d.file}:${d.line}` : `${d.file}:${d.line}:${d.column}`
}

function sharedProject(tests: RunTestDescriptor[]): string | undefined {
  const names = new Set(tests.map((t) => t.projectName ?? ''))
  if (names.size === 1) return [...names][0] || undefined
  return undefined
}

function toArgs(filters: RunFilters, configFile: string, reporterModule: string | null): string[] {
  const args = ['test', '--config', configFile]
  if (reporterModule !== null) args.push('--reporter', reporterModule)
  const tests = filters.tests
  if (tests === undefined) return args // run all
  const project = sharedProject(tests)
  if (project !== undefined) args.push('--project', project)
  for (const d of tests) args.push(descriptorLocation(d))
  return args
}
```

- [ ] In `start()`, add the empty-tests guard right after the existing `already-running` guard (before spawning):

```ts
if (filters.tests !== undefined && filters.tests.length === 0) {
  return { ok: false, reason: 'no-tests' }
}
```

- [ ] Update the `setRunFiltered` call (currently `filters.files !== undefined || filters.project !== undefined`) to:

```ts
this.deps.setRunFiltered?.(filters.tests !== undefined)
```

### Step 6: Run the run-controller tests to verify they pass

- [ ] Run: `cd tests && bun test run-controller.test.ts`
- [ ] Expected: PASS.

### Step 7: Update run-routes to return 400 for no-tests

- [ ] In `src/server/run-routes.ts`, change `handleApiRun`'s final return (line 33-34) so `'no-tests'` yields 400 while `'no-config'`/`'already-running'` keep 409:

```ts
const result = runController.start(parsed)
if (result.ok) return Response.json(result)
const status = result.reason === 'no-tests' ? 400 : 409
return Response.json(result, { status })
```

### Step 8: Migrate server-routes tests

- [ ] In `tests/server-routes.test.ts`, find the tests using `{ files: ..., project: ... }` bodies (around line 1662-1683) and rewrite them to `{ tests: [...] }`. For example the "passes parsed files and project through" test becomes:

```ts
test('POST /api/run passes parsed tests through', async () => {
  // ...existing stub setup...
  const res = await handleHttpRequest(
    ctx,
    new Request('http://localhost/api/run', {
      method: 'POST',
      body: JSON.stringify({
        tests: [{ file: 'a.spec.ts', line: 5, column: 3, projectName: 'chromium', titlePath: ['t'] }],
      }),
    }),
    stub,
  )
  expect(res.status).toBe(200)
  expect(stub.startCalls[0]).toEqual({
    tests: [{ file: 'a.spec.ts', line: 5, column: 3, projectName: 'chromium', titlePath: ['t'] }],
  })
})
```

(Adjust the stub field name to `startCalls` if the existing stub records `start` arguments differently — match the existing stub's recording shape.)

- [ ] Add the no-tests test:

```ts
test('POST /api/run returns 400 for empty tests array', async () => {
  const res = await handleHttpRequest(
    ctx,
    new Request('http://localhost/api/run', { method: 'POST', body: '{"tests":[]}' }),
    stub,
  )
  expect(res.status).toBe(400)
})
```

### Step 9: Run all server tests + typecheck

- [ ] Run: `cd tests && bun test run-controller.test.ts server-routes.test.ts`
- [ ] Run: `bun run typecheck`
- [ ] Expected: all PASS. (The client still sends the old shape, but no client unit tests exercise it, and TypeScript does not cross-check the fetch body against the server schema. The Playwright UI snapshot tests do not spawn runs.)

### Step 10: Commit

- [ ] Run:

```bash
git add src/schemas/http.ts src/server/run-controller.ts src/server/run-routes.ts tests/run-controller.test.ts tests/server-routes.test.ts
git commit -m "feat(run-controller): descriptor-based filter with positional translation"
```

---

## Task 4: `--test-list` path, version detection, temp-file lifecycle (#6)

**Files:**

- Modify: `src/server/run-controller.ts`
- Modify: `tests/run-controller.test.ts`
- Create: `tests/fixtures/playwright-list-sample.txt`

### Step 1: Capture a real `--list` sample for entry-format validation

- [ ] Run: `bunx playwright test --list 2>&1 | head -20 > tests/fixtures/playwright-list-sample.txt`
- [ ] Open the file and confirm it contains lines like `  [chromium] › tests/...spec.ts:N:M › suite › test title` (or the no-project form). Note the exact file-path form (relative to cwd) and separator Playwright uses for this repo. This anchors the entry-format test in Step 5.

### Step 2: Add the version-detection helper and write its test

- [ ] In `tests/run-controller.test.ts`, add:

```ts
import { gteMinor } from '../src/server/run-controller'

describe('gteMinor', () => {
  test('true when version meets the threshold', () => {
    expect(gteMinor('1.56.0', 1, 56)).toBe(true)
    expect(gteMinor('1.59.0-beta', 1, 56)).toBe(true)
    expect(gteMinor('2.0.0', 1, 56)).toBe(true)
  })
  test('false when version is below the threshold', () => {
    expect(gteMinor('1.55.0', 1, 56)).toBe(false)
    expect(gteMinor('1.40.1', 1, 56)).toBe(false)
  })
  test('false for unparseable input', () => {
    expect(gteMinor('', 1, 56)).toBe(false)
    expect(gteMinor('not-a-version', 1, 56)).toBe(false)
  })
})
```

### Step 3: Run the test to verify it fails

- [ ] Run: `cd tests && bun test run-controller.test.ts`
- [ ] Expected: FAIL — `gteMinor` not exported.

### Step 4: Implement `gteMinor` and version detection

- [ ] In `src/server/run-controller.ts`, add:

```ts
export function gteMinor(version: string, major: number, minor: number): boolean {
  const match = /^(\d+)\.(\d+)/.exec(version.trim())
  if (match === null) return false
  const maj = parseInt(match[1]!, 10)
  const min = parseInt(match[2]!, 10)
  if (maj !== major) return maj > major
  return min >= minor
}

function resolvePlaywrightVersion(cwd: string): string | null {
  try {
    const req = createRequire(join(cwd, 'package.json'))
    const pkgPath = req.resolve('@playwright/test/package.json')
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require(pkgPath).version as string
  } catch {
    return null
  }
}
```

Add `getPlaywrightVersion?` to `RunControllerDeps` (after `resolveLaunch?`):

```ts
getPlaywrightVersion?: (cwd: string) => string | null
```

### Step 5: Write the entry-builder test (anchors the Implementation Risk)

- [ ] In `tests/run-controller.test.ts`, add (use the real file path + title path observed in Step 1's sample; substitute the actual values you captured):

```ts
import { buildTestListEntries } from '../src/server/run-controller'

describe('buildTestListEntries', () => {
  test('formats one line per descriptor matching playwright --list shape', () => {
    const entries = buildTestListEntries([
      { file: 'tests/foo.spec.ts', line: 10, column: 5, projectName: 'chromium', titlePath: ['suite', 'does a thing'] },
    ])
    // NOTE: adjust the expected line to exactly match the form in
    // tests/fixtures/playwright-list-sample.txt for the same test.
    expect(entries).toEqual(['[chromium] › tests/foo.spec.ts:10:5 › suite › does a thing'])
  })

  test('omits the project prefix when projectName is empty', () => {
    const entries = buildTestListEntries([{ file: 'tests/foo.spec.ts', line: 10, titlePath: ['does a thing'] }])
    expect(entries).toEqual(['tests/foo.spec.ts:10 › does a thing'])
  })
})
```

### Step 6: Implement `buildTestListEntries`

- [ ] In `src/server/run-controller.ts`, add:

```ts
export function buildTestListEntries(tests: RunTestDescriptor[]): string[] {
  return tests.map((d) => {
    const loc = descriptorLocation(d)
    const title = d.titlePath.join(' \u203a ')
    const prefix = d.projectName ? `[${d.projectName}] \u203a ` : ''
    return `${prefix}${loc} \u203a ${title}`
  })
}
```

(`\u203a` is the `›` separator.)

### Step 7: Write the test-list spawn + temp-file lifecycle test

- [ ] Add to `Fixture` interface: `deleteTempFiles: string[]` and extend the fixture to record temp-file deletion. Add a stubbed file writer to deps. In `createFixture`, add:

```ts
const writtenTempFiles: Array<{ path: string; content: string }> = []
const deletedTempFiles: string[] = []
```

Add to `deps`:

```ts
writeTempFile: (content: string) => string => {
  const path = `/tmp/crvy-rprtr-test-list-${writtenTempFiles.length}.txt`
  writtenTempFiles.push({ path, content })
  return path
},
deleteTempFile: (path: string) => {
  deletedTempFiles.push(path)
},
```

Add to `RunControllerDeps`:

```ts
writeTempFile?: (content: string) => string
deleteTempFile?: (path: string) => void
```

Add to the returned fixture object: `writtenTempFiles`, `deletedTempFiles`.

- [ ] Add the test:

```ts
describe('RunController --test-list path', () => {
  test('suite uses --test-list on Playwright >= 1.56 and cleans up on exit', () => {
    const f = createFixture(SAMPLE_CTX, () => null)
    f.setPlaywrightVersion('1.56.0')
    const descriptors = [
      { file: 'a.spec.ts', line: 1, projectName: 'chromium', titlePath: ['t1'] },
      { file: 'b.spec.ts', line: 2, projectName: 'chromium', titlePath: ['t2'] },
    ]
    const result = f.controller.start({ tests: descriptors })
    expect(result).toEqual({ ok: true })
    expect(f.spawnCalls[0]!.args).toContain('--test-list')
    const listPath = f.spawnCalls[0]!.args[f.spawnCalls[0]!.args.indexOf('--test-list') + 1]
    expect(f.writtenTempFiles).toHaveLength(1)
    expect(f.writtenTempFiles[0]!.path).toBe(listPath)
    expect(f.writtenTempFiles[0]!.content).toBe(
      '[chromium] \u203a a.spec.ts:1 \u203a t1\n[chromium] \u203a b.spec.ts:2 \u203a t2',
    )
    // child exit deletes the file
    f.child.exitEmitters.forEach((cb) => cb(0))
    expect(f.deletedTempFiles).toContain(listPath)
  })

  test('suite falls back to positional args on Playwright < 1.56', () => {
    const f = createFixture(SAMPLE_CTX, () => null)
    f.setPlaywrightVersion('1.55.0')
    f.controller.start({
      tests: [
        { file: 'a.spec.ts', line: 1, projectName: 'chromium', titlePath: ['t1'] },
        { file: 'b.spec.ts', line: 2, projectName: 'chromium', titlePath: ['t2'] },
      ],
    })
    expect(f.spawnCalls[0]!.args).not.toContain('--test-list')
    expect(f.writtenTempFiles).toHaveLength(0)
    expect(f.spawnCalls[0]!.args).toContain('a.spec.ts:1')
  })

  test('temp file is deleted on stop and on dispose', () => {
    const f = createFixture(SAMPLE_CTX, () => null)
    f.setPlaywrightVersion('1.59.0')
    f.controller.start({
      tests: [
        { file: 'a.spec.ts', line: 1, titlePath: ['t1'] },
        { file: 'b.spec.ts', line: 2, titlePath: ['t2'] },
      ],
    })
    const listPath = f.spawnCalls[0]!.args[f.spawnCalls[0]!.args.indexOf('--test-list') + 1]
    f.controller.dispose()
    expect(f.deletedTempFiles).toContain(listPath)
  })
})
```

Add `setPlaywrightVersion` to the fixture (sets the injected `getPlaywrightVersion`):

```ts
setPlaywrightVersion: (version: string | null) => {
  playwrightVersion = version
},
```

with `let playwrightVersion: string | null = null` in the fixture and `getPlaywrightVersion: () => playwrightVersion` in deps.

### Step 8: Run the test to verify it fails

- [ ] Run: `cd tests && bun test run-controller.test.ts`
- [ ] Expected: FAIL — `start()` does not yet branch on version or write temp files.

### Step 9: Implement the test-list branch and lifecycle in `start()`

- [ ] Add a private field to `RunController`:

```ts
private testListPath: string | null = null
```

- [ ] In `start()`, after the empty-tests guard and after computing `reporterModule`, branch for suites. Replace the single `toArgs` call with strategy selection. The full `start()` body from the guards onward becomes:

```ts
const resolveReporter = this.deps.resolveReporter ?? resolveReporterDefault
const reporterModule = resolveReporter(ctx.cwd)
const tests = filters.tests
const useTestList = tests !== undefined && tests.length > 1 && this.supportsTestList(ctx.cwd)

const args = ['test', '--config', ctx.configFile]
if (reporterModule !== null) args.push('--reporter', reporterModule)

if (useTestList && tests !== undefined) {
  const content = buildTestListEntries(tests).join('\n')
  this.testListPath = (this.deps.writeTempFile ?? defaultWriteTempFile)(content)
  args.push('--test-list', this.testListPath)
} else if (tests !== undefined && tests.length > 0) {
  const project = sharedProject(tests)
  if (project !== undefined) args.push('--project', project)
  for (const d of tests) args.push(descriptorLocation(d))
}
// tests === undefined or length 0 handled above → run-all (no extra args) / no-tests

const resolveLaunch = this.deps.resolveLaunch ?? resolvePlaywrightLaunch
const { cmd, args: launchArgs } = resolveLaunch(ctx.cwd, args)
const child = this.deps.spawn(cmd, launchArgs, { cwd: ctx.cwd, env: buildSpawnEnv(this.deps.port), stdio: 'inherit' })
// ...rest unchanged (this.child = child, on/exit, setReportRunning, setRunFiltered, broadcast)
```

Add the helpers:

```ts
private supportsTestList(cwd: string): boolean {
  const getVersion = this.deps.getPlaywrightVersion ?? resolvePlaywrightVersion
  const version = getVersion(cwd)
  return version !== null && gteMinor(version, 1, 56)
}
```

```ts
import { writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join as joinPath } from 'node:path'

function defaultWriteTempFile(content: string): string {
  const path = joinPath(tmpdir(), `crvy-rprtr-test-list-${process.pid}-${Date.now()}.txt`)
  writeFileSync(path, content, 'utf8')
  return path
}

function defaultDeleteTempFile(path: string): void {
  try {
    unlinkSync(path)
  } catch {
    /* ignore */
  }
}
```

- [ ] Add cleanup calls. In `handleChildExit`, after clearing `this.child`, add:

```ts
this.cleanupTempFile()
```

In `stop()`, after `this.child.kill('SIGTERM')` is scheduled, and in `dispose()`, also call `this.cleanupTempFile()`. Define:

```ts
private cleanupTempFile(): void {
  if (this.testListPath !== null) {
    const del = this.deps.deleteTempFile ?? defaultDeleteTempFile
    del(this.testListPath)
    this.testListPath = null
  }
}
```

- [ ] Delete the now-unused `toArgs` function (its logic was inlined) — or keep `descriptorLocation`/`sharedProject` which are still used. Remove only `toArgs`.

### Step 10: Run all run-controller tests

- [ ] Run: `cd tests && bun test run-controller.test.ts`
- [ ] Expected: PASS, including `gteMinor`, `buildTestListEntries`, and the three `--test-list` lifecycle tests.

### Step 11: Commit

- [ ] Run:

```bash
git add src/server/run-controller.ts tests/run-controller.test.ts tests/fixtures/playwright-list-sample.txt
git commit -m "feat(run-controller): --test-list for suites with version fallback"
```

---

## Task 5: Client migration — descriptors, no-location feedback, isRunning guard (#4, #5 client, #6 client, #7)

**Files:**

- Modify: `src/client/App.svelte` (lines 33-36 type, 289-334 handlers)

### Step 1: Update the local types

- [ ] In `src/client/App.svelte`, replace the `RunFilters` interface (line 33-36) with:

```ts
interface RunTestDescriptor {
  file: string
  line: number
  column?: number
  projectName?: string
  titlePath: string[]
}

interface RunFilters {
  tests?: RunTestDescriptor[]
}
```

### Step 2: Add the descriptor builder and rewrite `handleRunItem`

- [ ] Replace `handleRunItem` (line 308-334) with:

```ts
function toDescriptor(test: CrvyRprtrTest): RunTestDescriptor | null {
  const file = test.location?.file
  const line = test.location?.line
  if (file === undefined || line === undefined) return null
  return {
    file,
    line,
    column: test.location?.column,
    projectName: test.projectName,
    titlePath: [...(test.titlePath ?? []), test.title],
  }
}

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

### Step 3: Add the `isRunning` guard to `handleStart`

- [ ] Replace the start of `handleStart` (line 289-293). The new top of the function:

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

(Handling 400 here is defensive: the client guards against empty descriptors locally, so the server's 400 should never trigger, but if it does the user sees a message instead of a silent failure.)

### Step 4: Typecheck and build

- [ ] Run: `bun run typecheck`
- [ ] Run: `bun run build`
- [ ] Expected: both PASS. The Svelte compile validates the new types.

### Step 5: Manual smoke check (optional but recommended)

- [ ] Run: `bun run start`
- [ ] Open http://localhost:3000, click ▶ (run all) and a per-test ▶. Confirm runs start, the tree flips to pending, and results stream in. Confirm a test without `location` (if present) shows the "Cannot run" message. Stop the server.

### Step 6: Commit

- [ ] Run:

```bash
git add src/client/App.svelte
git commit -m "feat(client): descriptor filters, no-location feedback, isRunning guard"
```

---

## Self-Review (completed during authoring)

**Spec coverage:**

- #1 PM launcher → Task 1. ✓
- #2 robust reporter resolution → Task 2. ✓
- #4 no-location feedback → Task 5 Step 2. ✓
- #5 suite project scoping → Task 3 Step 5 (`sharedProject` in positional path); test-list encodes per-line (Task 4). ✓
- #6 `--test-list` with version fallback → Task 4; positional fallback in Task 3. ✓
- #7 client `isRunning` guard → Task 5 Step 3. ✓
- Non-Goals #3/#8/#9 — intentionally untouched; no task touches CI-env stripping, static HTML, or stop escalation. ✓
- Schema migration (`RunRequestBodySchema`, `RunResponseSchema`) → Task 3 Step 1. ✓
- `StartResult` `'no-tests'` → Task 3 Step 2. ✓
- 400 for no-tests → Task 3 Step 7. ✓
- Temp-file lifecycle (exit/stop/dispose) → Task 4 Step 9 + tests Step 7. ✓
- Implementation Risk validation → Task 4 Step 1 (capture sample) + Step 5 (entry-builder test anchored to sample). ✓

**Type consistency:** `RunTestDescriptor` shape (`file`, `line`, `column?`, `projectName?`, `titlePath`) is identical across `schemas/http.ts` (Task 3 Step 1), `run-controller.ts` (`RunFilters` Task 3 Step 2, helpers Task 4), and `App.svelte` (Task 5 Step 1). `RunFilters = { tests?: RunTestDescriptor[] }` consistent server- and client-side. Fixture additions (`setResolveLaunch`, `setPlaywrightVersion`, `writtenTempFiles`, `deletedTempFiles`) introduced before the tests that use them.

**Placeholder scan:** No TBD/TODO. Every code step contains the actual code. One test (Task 4 Step 5) instructs the implementer to substitute the exact file path/title observed in the captured `--list` sample — this is intentional ground-truth validation, not a placeholder, and the expected-value line shows the exact format to match.

**Note on the `--list` file-path form:** Step 1 of Task 4 captures the real sample precisely because `location.file`'s form (relative vs absolute, separators) must match Playwright's own output. If the captured sample shows a path form that differs from what `test.location.file` yields, the implementer must reconcile by transforming `descriptor.file` in `buildTestListEntries` (e.g. make relative to cwd) — the entry-builder test will fail loudly and force the correction. This is the spec's Implementation Risk made concrete.
