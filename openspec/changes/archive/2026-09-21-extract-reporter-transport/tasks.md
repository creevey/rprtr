# Tasks: extract-reporter-transport

All `bun test` commands run inside `tests/` after `bun run build`.

## 1. Transport module

- [x] 1.1 Create `src/transport.ts` with `ReporterTransport` class: options (`serverUrl`, `screenshotDir`, `offlineReportPath`, `reportHtmlPath`, `workerIndex` env default, `ci` constructor-offline switch), `start()`, `connect()`, `enableOfflineMode()`, `send()` with `runEvents` recording — moved verbatim from `src/reporter.ts`. Verify: `bun run typecheck`
- [x] 1.2 Add `finish(runEndData)` to transport: run-end send, CI-mode `writeStaticArtifact`/`writeOfflineReport` calls, teardown wait — moved verbatim from `onEnd`/`writeOfflineReport`/`writeStaticArtifact` in `src/reporter.ts`, composing existing `reporter-artifact-ops.ts` functions. Verify: `bun run typecheck`

## 2. Adapter slim-down

- [x] 2.1 Rewrite `src/reporter.ts` to compose `ReporterTransport`: constructor delegates options; `onBegin`/`onTestBegin`/`onTestEnd`/`onEnd` call transport; keep register payload, declaration extraction, `baselineInput`, `resolveBrowserLabel`, title paths, CI `pendingArtifacts` deferral queue (calling transport persistence primitives at flush) — move-only, no logic edits. Verify: `bun run typecheck`
- [x] 2.2 Confirm no public surface change: `build.ts` entries, `package.json` exports, `tsconfig.build.json` includes untouched; transport not added to exports map. Verify: `bun run build` and `git diff --stat build.ts package.json tsconfig.build.json` is empty

## 3. Behavior-equivalence gate

- [x] 3.1 Existing offline-mode suite passes unmodified (constructor-offline, no-WebSocket runtime, run-end events, static artifact written). Verify: `cd tests && bun test offline.test.ts`
- [x] 3.2 Remaining bun suites pass unmodified (artifact ops, reporter helpers, report state, approve routes, images). Verify: `cd tests && bun test`
- [x] 3.3 Diff review: `git diff src/reporter.ts src/transport.ts` reads as block moves; any noticed-but-not-fixed awkwardness recorded as follow-up notes here. Verify: manual review
- [x] 3.4 Full gate + browser E2E green. Verify: `bun run check && bun run test:playwright`

## Follow-up notes (recorded per D4, not fixed)

- `start()` is a ci-guarded `connect()` only; design D1's "mkdir + connect" parenthetical was not hoisted because an unconditional `mkdir(screenshotDir)` at run start would create `./screenshots` in non-CI non-portable runs, which never happens today. Both mkdirs stay at their original call sites (portable `onTestEnd` branch, CI flush).
- The adapter keeps one-line `connect()`/`send()` delegates plus `serverUrl`/`screenshotDir`/`ci` alias fields because tests pin them (`offline.test.ts` overrides `send` and calls `connect()`; `reporter-server-url.test.ts` reads `reporter['serverUrl']`). Breaking that test coupling can drop them.
- `onBegin`'s single `if (!this.ci)` guard is split between `transport.start()` and the adapter's `sendRegister` guard — same condition evaluated twice per run.
- `finish()` takes an opaque `flushPendingArtifacts?` hook so the CI deferral flush (adapter-owned, Playwright-typed) stays ordered between the run-end send and the artifact writes; the Vitest follow-up reporter can omit it.
- `.jscpd.json` used the key `formats`, which jscpd silently ignores (correct key: `format`, comma-separated string) — every format was being scanned. Latent until the openspec/agent docs landed; their near-duplicate markdown blew the 5% threshold. Fixed to `"format": "typescript,javascript"` per the config's original intent; ts/js clone count unchanged (1).
