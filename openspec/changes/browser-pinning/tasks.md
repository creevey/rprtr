## 1. Shared pin module (`src/browser-pins.ts`)

- [x] 1.1 Write failing tests for the pin schema and segment matcher in `tests/browser-pins.test.ts`: valid prefixes (`147`, `147.0`, full version), non-match (`147.0.77` vs `147.0.7727.15`, `147` vs `149.0.7827.55`), invalid values (`''`, non-numeric segment, `latest`, unknown browser). Verify: `bun test browser-pins.test.ts` (from `tests/`, after `bun run build`) fails as expected; `bun run typecheck`
- [x] 1.2 Implement the Zod pin schema and segment-wise prefix matcher; tests pass. Verify: `bun test browser-pins.test.ts`; `bun run typecheck`
- [x] 1.3 Write failing tests for effective-environment resolution using manifest fixtures: revision/version resolved from `executablePath()` plus manifest; platform `revisionOverride` active → `unverifiable`; project `use.channel` or `launchOptions.executablePath` → `unverifiable`; no pin → `unpinned`. Verify: `bun test browser-pins.test.ts` fails as expected
- [x] 1.4 Implement environment resolution and move the installed-Playwright-version reader from `src/server/docker-support.ts` into the module (server imports it from there). Verify: `bun test browser-pins.test.ts`; `bun run typecheck`
- [x] 1.5 Write failing tests for status derivation and the `browserPinPolicy` decision (`warn` never fails, `fail` fails on drift only). Implement. Verify: `bun test browser-pins.test.ts`; `bun run typecheck`

## 2. Reporter integration

- [x] 2.1 Write failing tests in `tests/browser-pin-reporter.test.ts` for reading pins from project metadata and config-root fallback, project-over-root precedence, and invalid-pin init errors naming the project and value. Verify: `bun test browser-pin-reporter.test.ts` fails as expected
- [x] 2.2 Implement metadata reading and validation in `src/reporter.ts`; add `browserPinPolicy` to `CrvyRprtrOptions` in `src/reporter-helpers.ts`. Verify: `bun test browser-pin-reporter.test.ts`; `bun run typecheck`
- [x] 2.3 Write failing tests that a run emits an `environments` map keyed by project (Playwright version, browser version, revision, Docker image when docker mode, status) in the reporter payloads. Implement emission. Verify: `bun test browser-pin-reporter.test.ts`; `bun run typecheck`
- [x] 2.4 Write failing tests for the `fail` policy path (drift fails the run with project, pin, effective build, and remedy in the message; `unverifiable`/`unpinned` never fail). Implement. Verify: `bun test browser-pin-reporter.test.ts`; `bun run typecheck`

## 3. Report surfaces and schemas

- [x] 3.1 Write failing tests in `tests/browser-pin-artifacts.test.ts` that `environments` is optional in the report schema and report state, that artifacts without it load with `unknown` status, and that offline/static writers carry it. Verify: `bun test browser-pin-artifacts.test.ts` fails as expected
- [x] 3.2 Implement the optional `environments` field across `src/schemas.ts`, `src/report-state.ts`, `src/report-artifact.ts`, and `src/offline-reports.ts`. Verify: `bun test browser-pin-artifacts.test.ts`; `bun run typecheck`
- [x] 3.3 Write failing tests that the server accepts and re-serves `environments` (sync payload and artifact routes). Implement the server-side plumbing. Verify: `bun test browser-pin-artifacts.test.ts`; `bun run typecheck`

## 4. UI pin status

- [x] 4.1 Write failing client-helper tests for pin-status labels and drift marking (pinned / drift / unpinned / unverifiable / unknown). Implement helpers. Verify: `bun test browser-pin-client.test.ts`; `bun run typecheck`
- [x] 4.2 Implement the pin badge in the run header and project node, and drift marking on tests in the Svelte client. Verify: `bun run test:playwright` with a new e2e scenario covering badge states; `bun run typecheck`

## 5. Docker preflight

- [x] 5.1 Write failing tests in `tests/docker-preflight.test.ts`: a pin the installed Playwright version cannot satisfy rejects the run before any container starts and names the matching image tag; a satisfied pin proceeds and records the image. Verify: `bun test docker-preflight.test.ts` fails as expected
- [x] 5.2 Implement the preflight in the Docker run path using the shared module. Verify: `bun test docker-preflight.test.ts`; `bun run typecheck`

## 6. CLI `browsers` command group

- [x] 6.1 Write failing tests in `tests/cli-browsers.test.ts` for argument routing: `browsers list|resolve|check` dispatch, artifact-dir mode unchanged, unknown subcommand diagnostics. Verify: `bun test cli-browsers.test.ts` fails as expected
- [x] 6.2 Implement routing and `list`/`resolve` against a fixture build map: stable-only by default, `--all`, newest-build recommendation with alternatives, nearest-major hint on no match, cache with a 24h TTL and `--refresh`, probe fallback when the cached map lacks a prefix, offline diagnostic with non-zero exit. Verify: `bun test cli-browsers.test.ts`; `bun run typecheck`
- [x] 6.3 Write failing tests for `browsers check`: pins read from the Playwright JSON reporter's `config`/project metadata, drift reported, `--strict` exits non-zero on drift only, offline path works, `unverifiable`/`unpinned` never fail. Verify: `bun test cli-browsers.test.ts` fails as expected
- [x] 6.4 Implement `check` by spawning `playwright test --list --reporter=json` and evaluating pins against the installed environment. Verify: `bun test cli-browsers.test.ts`; `bun run typecheck`

## 7. Docs and full gate

- [x] 7.1 Update `README.md` (reporter option, `browsers` CLI group) and add the pin contract plus the creevey `browserVersion` migration note to `docs/docker-screenshot-determinism.md` and `docs/text-antialiasing-determinism.md`. Verify: `bun run format:check`
- [x] 7.2 Run the example flows to confirm unpinned behavior is unchanged: `bun run example` and `bun run example:ct`. Fix any regressions. Note: `bun run example` is a pre-existing stale script — `examples/playwright` was removed in 8acfacf, so it cannot run; `bun run example:ct` (7/7) and the unpinned repo e2e suite (`bun run test:playwright`, 27/27) confirm unchanged behavior
- [x] 7.3 Full gate: `bun run check` plus `bun run test:playwright`; fix all failures
- [x] 7.4 Validate the change artifacts: `openspec validate browser-pinning --strict` passes
