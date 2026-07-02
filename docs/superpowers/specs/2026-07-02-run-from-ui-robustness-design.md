# Run-From-UI Robustness Design

**Date:** 2026-07-02
**Topic:** Harden the existing "run tests from the report web UI" feature: reliable process spawning, reliable reporter loading, precise and unbounded test filtering, and feedback when a run cannot be scoped.

## Overview

The run-from-UI feature (`src/server/run-controller.ts`, `src/client/App.svelte`) spawns `playwright test` as a child process when the user clicks Start (▶) or a per-test/per-suite run button. Six sharp edges were identified in the current implementation. This design addresses the four real bugs and the two borderline items; three other noted behaviors are intentionally out of scope (see Non-Goals).

The items in scope:

- **#1** — `npx playwright` is hardcoded (`run-controller.ts:53` `resolveBin` ignores cwd).
- **#2** — `--reporter @crvy/rprtr` is injected only when `createRequire(cwd).resolve('@crvy/rprtr')` succeeds (`run-controller.ts:65`); otherwise a run can be silent, and co-configured reporters (notably the HTML reporter) can hang the child.
- **#4** — A per-test/per-suite ▶ with no `location` is a silent no-op (`App.svelte:316,331`).
- **#5** — Suite runs never pass `--project`, so a single-project suite can run unrelated projects' matching files.
- **#6** — Large suites emit one positional `file:line:column` per descendant test, risking the OS command-line length limit.
- **#7** — `handleStart` has no client-side `isRunning` guard; an in-flight full run can wrongly flip the tree to `pending` before the server's 409 arrives.

## Background: verified facts

- **The local Playwright CLI is resolvable.** `node_modules/.bin/playwright -> ../@playwright/test/cli.js` exists and is a `#!/usr/bin/env node` script. `createRequire(join(cwd,'package.json')).resolve('@playwright/test/cli.js')` returns an absolute path.
- **Creevey already has a package-manager-resolution pattern.** `creevey/src/server/index.ts:4-5` uses `package-manager-detector`: `getUserAgent()` (reads `npm_config_user_agent`) and `detect/detectSync({cwd})` (reads the `packageManager` field + lockfiles), then `resolveCommand(agent, 'execute-local', [...])`. The `execute-local` command maps npm→`npx`, pnpm→`pnpm exec`, yarn→`yarn exec`, bun→`bun x`, deno→`deno task --eval`.
- **The HTML reporter can hang a spawned run.** `node_modules/playwright/lib/reporters/html.js:130` `onExit` starts a blocking webserver via `showHTMLReport` only when `shouldOpen` is true:
  ```js
  shouldOpen =
    !isCodingAgent && !!process.stdin.isTTY && (this._open === 'always' || (!ok && this._open === 'on-failure'))
  ```
  `_open` defaults to `"on-failure"`. The spawned child uses `stdio: 'inherit'`, so it **inherits the server's TTY**. A failing run therefore starts the HTML server and blocks until the browser tab is closed — the child never exits and `RunController` never observes `exit`, leaving the UI stuck in "running". `PLAYWRIGHT_HTML_OPEN=never` (already set in `buildSpawnEnv`) makes `_open="never"` and prevents the server, but relying on an env var to suppress a co-configured reporter is fragile, and even non-hanging co-configured reporters (HTML rebuild, Slack, custom reporters) fire on every UI re-run.
- **CLI `--reporter` fully replaces config reporters.** Passing `--reporter <path>` means only that reporter runs for the invocation, regardless of the `reporter` field in `playwright.config`. (Playwright docs: "--reporter <reporter>: Reporter to use… You can also pass a path to a custom reporter file.")
- **`--test-list <file>` was introduced in Playwright 1.56.** It accepts a file with one entry per line, format `[project] › path/to/file.spec.ts:line:column › suite › test title`. Line/column numbers are **ignored** — matching is by project + file path + title path. Separators `›` or `>` are both accepted. A missing `[project]` prefix means "all projects". This project's `peerDependencies` is `@playwright/test >=1.40`, so `--test-list` cannot be used unconditionally.
- **The `titlePath` field sent to clients is describe-suites-only.** `reporter.ts:167` sends `this.describeTitlePath(test)` (the `describe` block titles), **not** the file or the test title. The test title is the separate `title` field. Therefore the full Playwright title-path segment for a test-list entry is `[...test.titlePath, test.title]`.
- **`location.file` is Playwright's `test.location.file`.** Set at `reporter.ts:170`. Its exact form (relative vs absolute, path separators) must match Playwright's own `--list` output for `--test-list` entries to match — see Implementation Risk.

## Goals

1. Spawn the run with the project's actual package manager, not a hardcoded `npx`.
2. Always load `@crvy/rprtr` for UI-triggered runs (never silent, never hung on a co-configured reporter).
3. Remove the command-line length footgun for large suites.
4. Give feedback when a per-test/per-suite run cannot be scoped.
5. Keep single-test runs precisely scoped (no precision regression from title-based matching).
6. Cover all observable behavior with `bun:test` unit tests using the existing mock-context pattern; validate `--test-list` entry shape against real `playwright test --list` output.

## Non-Goals

1. **#3** — CI-env stripping and `PLAYWRIGHT_HTML_OPEN=never`. This is intentional: UI-triggered runs must behave as local interactive runs. Left as-is.
2. **#8** — Static HTML artifact is read-only. There is no server to spawn from; `runEnabled` is `false` there. Left as-is.
3. **#9** — Stop escalation (SIGTERM → 5s grace → SIGKILL) and `dispose()` immediate SIGKILL. This is correct, safe behavior. Left as-is.
4. Bumping the minimum supported Playwright version. `--test-list` is used only when the detected version supports it; older versions use the positional fallback.
5. Connection-watchdog / new outbound WebSocket message type. Made unnecessary by reliable reporter resolution (see Decision D2).
6. Surfacing child-process stdout/stderr in the UI. Playwright's output still goes to the server terminal.

## Design Decisions

### D1 (accepted): package-manager-detector for the launcher

Reuse Creevey's established pattern. Add `package-manager-detector` as a dependency. Resolve the launch command with `resolveCommand(agent, 'execute-local', ['playwright', ...])`, falling back to `npx` only when the agent cannot be detected. This serves pnpm/yarn/bun workspace setups and airgapped environments, and removes the hardcoded `npx`.

### D2 (accepted): keep the `--reporter` override; make resolution reliable; drop the watchdog

The "trust the user's config" approach is rejected because a co-configured HTML reporter hangs the spawned child (verified above), and other co-configured reporters fire unwanted side effects on every UI re-run. Instead, always inject `--reporter <path>`, resolving the module first from the project cwd and then from the server's own module location (`import.meta.url`) so it succeeds even for `bunx crvy-rprtr`/`npx crvy-rprtr` without a local install. Because CLI `--reporter` reliably overrides config and resolution now effectively always succeeds, the silent-failure case is eliminated at the source and the connection watchdog is unnecessary.

### D3 (accepted): descriptor-based filter; `--test-list` for suites with a version fallback

Replace the `{files, project}` request body with a uniform `tests: RunTestDescriptor[]` model so the server can translate either to positional args or a `--test-list` file. Single-test runs route to precise positional `file:line:column` (no precision loss from title-based matching). Suite runs use `--test-list` on Playwright ≥1.56 (no arg-length limit — the file is unbounded) and fall back to positional args on older versions.

### D4 (accepted): project scoping folded into the translation

For the `--test-list` path, project is encoded per-line. For the positional fallback, `--project` is added only when all descriptors share one `projectName`. This scopes single-project suites without breaking multi-project suites.

### D5 (accepted): feedback only when nothing can run

Surface `runMessage` when zero descriptors can be built (no `location`). Partial suite runs (some tests lack location) proceed on the runnable subset without a warning, to keep the interaction simple.

## Section A — Robust spawning (#1, #2)

### #1 — Use the project's package manager

Add `package-manager-detector` to `dependencies`. Replace `resolveBin` (`run-controller.ts:53`):

```ts
import { detectSync, getUserAgent } from 'package-manager-detector/detect'
import { resolveCommand } from 'package-manager-detector/commands'

function resolvePlaywrightLaunch(cwd: string, playwrightArgs: string[]): { cmd: string; args: string[] } {
  const agent = detectSync({ cwd })?.agent ?? getUserAgent()
  const resolved = agent !== null ? resolveCommand(agent, 'execute-local', ['playwright', ...playwrightArgs]) : null
  if (resolved !== null) return { cmd: resolved.command, args: resolved.args }
  return { cmd: 'npx', args: ['playwright', ...playwrightArgs] } // unknown-PM fallback
}
```

`detectSync` keeps `RunController.start` synchronous. `execute-local` maps: npm→`npx`, pnpm→`pnpm exec`, yarn→`yarn exec`, bun→`bun x`.

### #2 — Keep `--reporter` override; reliable resolution; no watchdog

```ts
function resolveReporter(cwd: string): string | null {
  try {
    return createRequire(join(cwd, 'package.json')).resolve('@crvy/rprtr')
  } catch {
    /* not installed locally */
  }
  try {
    return createRequire(import.meta.url).resolve('@crvy/rprtr')
  } catch {
    /* unreachable: server is @crvy/rprtr */
  }
  return null
}
```

- Always inject `--reporter <resolved>` when non-null (overrides config → no HTML hang, no stray side effects; the live UI is the report for these runs).
- Delete the connection-watchdog and the optional `message` field on `run-status` (never added).
- Keep `PLAYWRIGHT_HTML_OPEN=never` in `buildSpawnEnv` (`run-controller.ts:81`) as cheap defense-in-depth (effectively a no-op now, since HTML never loads, but harmless).

## Section B — Reliable filtering (#5, #6)

### Schema migration

`src/schemas/http.ts`: replace `RunRequestBodySchema`:

```ts
const RunTestDescriptorSchema = z.object({
  file: z.string(),
  line: z.number(),
  column: z.number().optional(),
  projectName: z.string().optional(),
  titlePath: z.array(z.string()),
})

export const RunRequestBodySchema = z.object({
  tests: z.array(RunTestDescriptorSchema).optional(),
})
```

This is a breaking change to the internal `/api/run` contract. The client and server ship together (v0.1.x), so both migrate in lockstep; there are no external consumers.

Also extend the failure reasons to include the new empty-filter case:

- `StartResult` (`run-controller.ts:17`): add `| { ok: false; reason: 'no-tests' }`.
- `RunResponseSchema` (`schemas/http.ts:19`): `reason: z.enum(['no-config', 'already-running', 'no-tests'])`. The route returns **400** (not 409) for `'no-tests'` since it is a malformed request, not a conflict.

### Server translation (`RunController`)

`RunFilters` becomes `{ tests?: RunTestDescriptor[] }`. `start(filters)`:

- `tests` **absent** → run all: `playwright test --config <cfg> --reporter <r>`.
- `tests: []` → `start` returns `{ ok: false, reason: 'no-tests' }`; the route responds **400**. This must never fall through to run-all.
- `tests: [one]` → positional: `... <file>:<line>:<col> [--project <projectName>]`.
- `tests` length > 1 (suite) → version-gated:
  - `supportsTestList(cwd)` true (Playwright ≥1.56) → write temp `--test-list` file, pass `--test-list <path>`.
  - else → positional `file:line:column` for each; add `--project <name>` iff all descriptors share one `projectName`.

Version detection (cached per process):

```ts
function supportsTestList(cwd: string): boolean {
  // resolve @playwright/test/package.json from cwd; parse major.minor; return >= 1.56.
  // unresolvable or unparseable → false (safe positional fallback).
}
```

No `semver` dependency: parse `major.minor` numerically and compare.

### `--test-list` entry construction

One line per descriptor:

```
[<projectName>] › <file>:<line>:<column> › <suite1> › <suite2> › … › <testTitle>
```

- Title-path segment = `descriptor.titlePath` joined by `›`. The descriptor's `titlePath` is the **full** Playwright title path: the client populates it as `[...test.titlePath, test.title]` (the `titlePath` field in `TestData` is describe-suites-only per `reporter.ts:167`, so the test title is appended client-side). The server joins it verbatim and does not append anything.
- Omit the `[projectName] › ` prefix when `projectName` is empty or absent (Playwright's default project has no name; no prefix means "all projects", which is correct for the default project).
- Line/column are ignored by Playwright but kept for human-readable diagnostics.

### Temp-file lifecycle

- Written to `os.tmpdir()` as `crvy-rprtr-test-list-<pid>-<timestamp>.txt` inside `start()` (suite + test-list path only).
- The path is stored on the `RunController` instance.
- Deleted (guarded `try/catch`, ignore errors) in `handleChildExit`, in `stop()` after the child is signaled, and in `dispose()`.

### Client change (`App.svelte`)

`handleRunItem` builds `tests` descriptors for both single and suite cases. `RunFilters` (local type in `App.svelte`) becomes `{ tests?: RunTestDescriptor[] }`. `handleStart(filters?)` is unchanged in mechanics: it POSTs `JSON.stringify(filters ?? {})`, which yields `{ tests: [...] }` for filtered runs and `{}` for run-all.

The descriptor builder maps a `CrvyRprtrTest` to `{ file: location.file, line: location.line, column: location.column, projectName: test.projectName, titlePath: [...test.titlePath, test.title] }`, returning `null` when `location` is missing.

### Implementation Risk (must be validated)

`--test-list` matches by file path + title path. If our entry's file-path form or title-path form does not exactly match Playwright's own `--list` output, **no tests match → silent no-op**. The implementation must:

1. Generate entries from real test data.
2. Run `playwright test --list` against the same project and compare the `file` and title-path segments token-for-token.
3. Add a unit test that asserts the generated entry shape against a captured `--list` sample.

## Section C — Client feedback (#4, #7)

Both are client-only changes in `App.svelte`. No server or schema changes.

### #4 — Feedback when nothing can run

In `handleRunItem`, if zero descriptors can be built, set `runMessage` and return without calling `/api/run`:

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

`runMessage` persists until the next `run-status` WebSocket message clears it (`App.svelte:411`), which is the desired behavior: it stays visible as guidance until the user starts a real run.

### #7 — Client-side `isRunning` guard

```ts
async function handleStart(filters?: RunFilters): Promise<void> {
  if (isRunning) {
    runMessage = 'A run is already in progress'
    return
  }
  // ...existing markTestsPending + fetch
}
```

This prevents the optimistic `markTestsPending` from corrupting the tree when a run is already in progress, and avoids a wasted round-trip. The UI affordances (header ▶ toggles to ■; tree ▶ is `pointer-events-none` when running) already prevent most clicks; the guard is defense-in-depth. The server 409 remains the source of truth.

## Testing Strategy

All server tests use the existing `bun:test` + injectable-fake pattern (`tests/run-controller.test.ts`).

### `tests/run-controller.test.ts` (extend)

- Launcher resolution: assert `detectSync`/`resolveCommand` are consulted; verify the produced `{cmd, args}` for a stubbed `pnpm`/`yarn`/`bun` agent and for the null-agent `npx` fallback. (Inject a fake `resolveLaunch` rather than depending on the real detector.)
- Reporter resolution: project-cwd path wins; falls back to `import.meta.url` path when the project throws; `--reporter` is always present when non-null and absent when null.
- Filter translation:
  - `tests` absent → run-all args.
  - `tests: []` → `{ ok: false, reason: 'no-tests' }`, no spawn.
  - single descriptor → positional `file:line:column` + `--project`.
  - suite + `supportsTestList` true → spawn args include `--test-list <path>`; the temp file content matches the expected entry lines; file is deleted on child exit, on `stop()`, and on `dispose()`.
  - suite + `supportsTestList` false → positional args; `--project` added only when all descriptors share one `projectName`.
- Version detection: stub the package.json read to return 1.56 (true), 1.55 (false), and unresolvable (false).

### `tests/server-routes.test.ts` (extend)

- `POST /api/run` with `{ tests: [] }` → 400.
- `POST /api/run` with `{ tests: [one] }` → 200, controller receives one descriptor.
- Existing `{ files, project }` shape is removed; update any test that used it.

### `--test-list` entry validation

A focused test that generates entries from a fixture `TestData` set and asserts the exact line format against a captured `playwright test --list` sample committed to the repo. This guards the Implementation Risk.

### Client

No unit-test harness for the Svelte client exists today; the client changes are covered by the existing Playwright UI snapshot tests (`tests/ui-controls.spec.ts`) and manual verification. (Consistent with the original run-from-UI spec's testing strategy.)

## Open Questions

None. All architectural decisions were resolved during brainstorming (D1–D5). The one residual risk (test-list entry matching) is explicitly called out and covered by the testing strategy.
