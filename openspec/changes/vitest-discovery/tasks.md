# Tasks: vitest-discovery

All bun tests run inside `tests/` (after `bun run build`). Verification commands end every task.

## 1. Discovery primitives

- [x] 1.1 Failing test first: `tests/vitest-discovery.test.ts` — parse `vitest list --json` stdout (fixture entries: name/file/projectName; malformed stdout → empty list; timeout/kill → empty list). Implement `src/server/vitest-discovery.ts`: `runVitestList({ configFile, cwd })` spawning via the run-launcher command resolution with `CI=true`, closed stdin, captured stdout, kill timeout; Zod-parse entries. Verify: `cd tests && bun test vitest-discovery.test.ts && cd .. && bun run typecheck`
- [x] 1.2 Tree synthesis: map entries to the streamed grouping — suites from the Vitest-root-relative file path, `pending` status, browser label from `projectName` via `getBrowserName`, `discovered:`-prefixed ids, identity `(file, full title path)`. Tests cover flat-file and nested-directory projects. Verify: `cd tests && bun test vitest-discovery.test.ts`

## 2. Startup seeding

- [x] 2.1 Failing test first: extend the seeding tests (`tests/vitest-discovery.test.ts` or a focused `server/app` seeding test mirroring existing app-level test style) — `seedRunContext` discovers `vitest.config.{ts,js,mts,mjs,cts,cjs}` when no `playwright.config.*` exists and seeds `{ runner: 'vitest', configFile, cwd }`; a Playwright config (or CLI `--config`) keeps precedence and skips Vitest discovery. Implement in `src/server/app.ts`. Verify: `cd tests && bun test vitest-discovery.test.ts && cd .. && bun run typecheck`
- [x] 2.2 Wire async seeding at server startup: after listen, seed the run context (await) and fire-and-forget the listing; listing failure logs once and leaves buttons enabled. Test: seeded app in a temp Vitest project dir exposes run controls and a pending tree without any run. Verify: `cd tests && bun test vitest-discovery.test.ts`

## 3. Merge, replace, persistence exclusion

- [x] 3.1 Merge semantics: discovered `pending` entries fill only identities absent from a loaded report; loaded results are never downgraded. Test: report with one of two discovered tests → report test keeps its status, the unknown one renders pending. Verify: `cd tests && bun test vitest-discovery.test.ts`
- [x] 3.2 Replacement: on run start, all `discovered:`-prefixed entries are dropped before streamed events land (stale identities disappear). Verify: `cd tests && bun test vitest-discovery.test.ts`
- [x] 3.3 Persistence exclusion: `saveReport` filters `discovered:` ids — report.json, offline JSON review, and the static HTML artifact contain no never-run pending entries. Verify: `cd tests && bun test report-persistence.test.ts vitest-discovery.test.ts`

## 4. Docs

- [x] 4.1 Update main `README.md` (run-buttons/server CLI section: Vitest discovery enables buttons and pre-run listing) and `examples/vitest-browser/README.md` (drop the "restart the server → buttons gone until next run" limitation in Run buttons + FAQ; note the pre-populated pending list). Verify: manual review against implemented behavior
- [x] 4.2 Full gate + browser regression. Verify: `bun run check && bun run test:playwright`
