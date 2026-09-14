# Tasks: vitest-runner

All `bun test` commands run inside `tests/` after `bun run build`.

## 1. Runner discriminator in the register contract (test-first)

- [x] 1.1 Write failing register tests: `RegisterDataSchema` parses `runner: 'vitest'` and rejects/ignores other values (safeParse null ⇒ Playwright default); `handleRegister` with a Vitest-shaped register (`configFile` + `cwd` + `runner: 'vitest'`) builds a run context resolving to the Vitest runner; old Vitest register (artifact dirs only) leaves run context unset; Playwright register without `runner` still builds a Playwright run context. Verify: `cd tests && bun test register-message.test.ts server-handlers.test.ts` (new cases fail)
- [ ] 1.2 Add optional `runner` literal to `RegisterDataSchema` (src/schemas.ts); carry the runner kind on the run context ('playwright' when absent); branch `buildRunContext` (Vitest: `rootDir = cwd`; Playwright: unchanged derivation). Verify: tests from 1.1 pass && `bun run typecheck`

## 2. Vitest reporter declares its runner (test-first)

- [x] 2.1 Write failing `tests/vitest-reporter.test.ts` cases: non-CI register payload carries `runner: 'vitest'`, `cwd` = project root, and `configFile` from the resolved config (mock sets `vitest.config.configFile`); `configFile` undefined (inline config) ⇒ field omitted, rest of payload unchanged; CI mode still sends no register. Verify: `cd tests && bun test vitest-reporter.test.ts` (new cases fail)
- [x] 2.2 Implement in `src/vitest.ts` `sendRegister`/`onInit` (D2): `configFile` from `vitest.config.configFile` with the `vitest.vite.config.configFile` fallback spike; omit when neither resolves. Verify: tests from 2.1 pass && `cd tests && bun test vitest-browser-integration.test.ts` (harness still green)
- [x] 2.3 Live-register integration test: add a non-CI config variant to the browser fixture (temp-copied, never the committed baselines); start the server programmatically on an ephemeral port, spawn the fixture Vitest run against it, assert the register payload arrives with `runner`/`configFile`/`cwd` and the run-enabled status flips true. Verify: `cd tests && bun test vitest-register-integration.test.ts`

## 3. Per-runner launch args (test-first)

- [x] 3.1 Write failing `tests/run-controller.test.ts` cases: Vitest run context ⇒ full-suite spawns `vitest run --config <configFile>`; update ⇒ `--update`; single test ⇒ file positional + `-t <titlePath joined>`; shared project ⇒ `--project=<name>`; mixed projects ⇒ no `--project`; never `--reporter` injection, no `--test-list` temp file, no Playwright version probe; existing Playwright assertions stay byte-identical. Verify: `cd tests && bun test run-controller.test.ts` (new cases fail)
- [x] 3.2 Implement (D4): extract `resolveLocalCommand(name, args)` from `resolvePlaywrightLaunch` in `src/server/run-launcher.ts` (package-manager-detector, npx fallback); runner branch in `RunController` arg building. Verify: tests from 3.1 pass && `cd tests && bun test run-launcher.test.ts` && `bun run typecheck`

## 4. Docker scoping for Vitest runs (test-first)

- [x] 4.1 Write failing tests: Vitest + explicit docker run mode ⇒ `{ ok: false, reason: 'docker-unsupported-for-runner' }` with no spawn; Vitest + auto ⇒ local spawn with one warning logged; Vitest + local ⇒ local spawn; Playwright + docker unchanged; `RunResponseSchema` accepts the new reason literal. Verify: `cd tests && bun test run-controller.test.ts run-request-schema.test.ts` (new cases fail)
- [x] 4.2 Implement (D5): run-mode awareness in `RunController` deps and the per-mode branch; add the reason to `RunResponseSchema` (src/schemas/http.ts). Verify: tests from 4.1 pass && `bun run typecheck`

## 5. Client run-error mapping

- [x] 5.1 Map `docker-unsupported-for-runner` to a clear message and make the `no-config` fallback provider-neutral in `src/client/App.svelte` (run error toast). Verify: `bun run build && bun run test:playwright` (ui-controls e2e green)

## 6. Docs

- [x] 6.1 README: drop "The UI does not launch Vitest runs" from the Vitest limitations list; document run buttons for both providers, the `-t` title-pattern approximation, docker refusal/auto-mode warning, and omitting `serverUrl` so UI-launched runs connect via `CRVY_RPRTR_SERVER_URL`; CLI `--config` stays documented Playwright-specific. Verify: manual review against spec scenarios

## 7. Gate

- [x] 7.1 Full gate + browser regression (UI behavior changed). Verify: `bun run check && bun run test:playwright && cd tests && bun test`
