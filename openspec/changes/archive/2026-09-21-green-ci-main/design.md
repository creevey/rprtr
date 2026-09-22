## Context

See proposal.md — Why. One decision here is not obvious and shapes the task list: where the browser-dependent integration tests belong.

Today `test:bun` is `bun run build && cd tests && bun test *.test.ts` — a single glob over every test file, executed by the `Bun Tests` job on a bare `ubuntu-latest` runner. Three of those files need a real browser. The `Playwright Tests` job already runs inside `mcr.microsoft.com/playwright:v1.59.0-noble`, where the browser exists.

The failure is worse than a red job: `vitest run` with an unlaunchable browser exits having run nothing, and `bun test` only noticed because an assertion happened to compare the event list. A test file that silently executes zero tests is the failure mode to design against, not just the missing browser.

## Goals / Non-Goals

**Goals:**

- Browser-dependent tests run where a browser exists, and a run that could not start one fails or skips loudly — never passes.
- The split is visible in the test layout, not implicit in a glob.

**Non-Goals:**

- Installing browsers into every job. That trades minutes on every push for a problem that only three files have.
- Changing what the integration tests assert.

## Decisions

**Split `test:bun` into a unit glob and a browser glob, rather than gating inside the test files.** A `test.skipIf(browserMissing)` would keep the files in the bare job and turn a real regression into a silent skip on any machine where browser resolution hiccups. Two scripts — `test:bun` for the runner-independent files and a browser-tests script executed by the container job — make the requirement structural: the bare job cannot run a browser test, and the container job cannot forget one. The two browser-dependent files live in `tests/browser/`, so the existing non-recursive `*.test.ts` glob excludes them without a negation and the split is visible in the layout.

**Assert a non-empty run inside the vitest integration helper.** `spawnFixtureVitestRun` already asserts the child's exit code; it should also assert the run reported at least one test. The signal is the offline report, not stdout: the fixture replaces vitest's reporters with `CrvyRprtrVitestReporter`, so a run prints nothing at all — a browserless run is visible as a report whose only event is `run-end`. This is the guard that would have turned "0 passed, 0 failed" into a clear failure the first time, independent of the job layout, and it costs one assertion.

**Commit the linux baseline rather than deriving a platform-independent path.** The snapshot path comes from `process.platform` because rendering genuinely differs per platform — that is the project's whole subject. Flattening the path would hide real differences. The fixture needs both PNGs, generated in the same container CI uses.

**Pack the example's dependency from source rather than pinning a published version.** The example exists to demonstrate the Vitest reporter, which has never been published, so `^0.3.3` from the registry makes `@crvy/rprtr/vitest` resolve to `error` and fails lint. The local alternatives are worse: `link:` resolves through Bun's global link store and dangles on a machine that has not run `bun link`, and `file:../..` copies the entire repository — `node_modules` included — into the example's own `node_modules`, recursively and without bound. A tarball packed at a relative path is what `tests/fixtures/docker-smoke` already does; its integrity hash changes on every build, so the example's `bun.lock` is untracked, which the lockfile check tolerates because it only scans tracked files.

**Add a lockfile-path check to the existing gate rather than a new workflow step.** A committed lockfile resolving to an absolute local path is a class of mistake, not a one-off; a grep for a filesystem-rooted resolution across `examples/*/bun.lock` and `bun.lock` belongs beside the other checks in `bun run check`, where a contributor hits it before pushing.

**Raise the `waitFor` budget to 10 s rather than retrying the test.** The assertion is about payload content, not latency; a longer ceiling costs nothing when the condition is met in milliseconds, and a retry would mask a genuine regression in connection setup.

## Risks / Trade-offs

- **Moving tests into the container job lengthens its critical path.** → Three files; the job already builds and runs Playwright. Acceptable against a bare job that reports false passes.
- **The linux baseline is generated once and could itself be wrong.** → It is reviewed as an image in the same PR, and the test that consumes it fails loudly rather than re-recording.
- **The glob split can be defeated by a new browser-dependent test that does not follow the naming convention.** → The non-empty-run assertion is the backstop: such a test fails in the bare job rather than passing vacuously.
