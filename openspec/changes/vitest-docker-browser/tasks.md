# Tasks

## 1. Foundations: version probe and config hook detection

- [x] 1.1 Write failing tests for the `resolvePlaywrightVersion` resolution order (`playwright` first, then `@playwright/test`, `null` when neither resolves) using temp fixture projects with stub `node_modules` package.json files. Verify: `cd tests && bun test playwright-install.test.ts` (new cases fail)
- [x] 1.2 Implement the `playwright` → `@playwright/test` order in `src/playwright-install.ts`. Verify: `cd tests && bun test playwright-install.test.ts` + `bun run typecheck`
- [x] 1.3 Write failing tests for `hasBrowserEndpointHook` (config referencing `CRVY_RPRTR_BROWSER_WS` → true; missing/unreadable file or unrelated config → false) and implement it in `src/server/browser-sidecar.ts`. Verify: `cd tests && bun test browser-sidecar.test.ts`

## 2. Browser sidecar module (`src/server/browser-sidecar.ts`)

- [x] 2.1 Write failing tests for `buildBrowserSidecarRunArgs`: detached `docker run` with `--rm --init --ipc=host`, PID-derived name, `-p 127.0.0.1::6677` ephemeral loopback publish, `--platform` only when configured, grayscale fontconfig drop-in mount (omitted for `fontRendering: 'inherit'`), `TZ=UTC`/`LANG=C.UTF-8`/`LC_ALL=C.UTF-8`, read-only project mount at `/work`, and the CLI selection order (`node /work/node_modules/playwright/cli.js` → `node /work/node_modules/@playwright/test/cli.js` → `npx -y playwright@<version>`) followed by `run-server --port 6677 --host 0.0.0.0`. Verify: `cd tests && bun test browser-sidecar.test.ts` (new cases fail)
- [x] 2.2 Implement `buildBrowserSidecarRunArgs` to green, including image precedence (explicit `docker.image` wins, else `mcr.microsoft.com/playwright:v<version>-noble`, else preparation error naming `docker.image`). Verify: `cd tests && bun test browser-sidecar.test.ts` + `bun run typecheck`
- [x] 2.3 Write failing tests for `createBrowserSidecar().ensure()` lifecycle: daemon probe failure; missing image emits `pulling` and pulls; container start emits `starting-sidecar`; `docker port` resolution + TCP readiness probe produce the `ws://127.0.0.1:<port>/` endpoint; readiness timeout / pull failure / unresolvable image reject and remove any started container; a warm ready container is reused without a second `docker run`; a stale container is force-removed and restarted; `dispose()` removes the container. Verify: `cd tests && bun test browser-sidecar.test.ts` (new cases fail)
- [x] 2.4 Implement `ensure()` and `dispose()` to green with injectable exec/CLI-existence/TCP-probe/timer seams (no new npm dependencies). Verify: `cd tests && bun test browser-sidecar.test.ts` + `bun run typecheck`

## 3. RunController integration

- [x] 3.1 Write failing tests for the Vitest backend decision in `start()`: explicit docker with the hook → local spawn with `CRVY_RPRTR_BROWSER_WS` set and `run-status` mode `docker`; explicit docker without the hook → `{ ok: false, reason: 'docker-missing-browser-hook' }` with no spawn and no sidecar call; auto with a docker backend and no hook → one warning plus local spawn; auto with a docker backend and the hook → sidecar; auto/local without a docker backend → local spawn, no sidecar; start before a successful `prepareRun` → `{ ok: false, reason: 'docker-unavailable' }`; Playwright paths unchanged. Verify: `cd tests && bun test run-controller.test.ts` (new cases fail)
- [x] 3.2 Implement the backend decision, spawn-env injection, and effective-mode broadcasting in `src/server/run-controller.ts` to green. Verify: `cd tests && bun test run-controller.test.ts` + `bun run typecheck`
- [x] 3.3 Write failing tests for `prepareRun()` / teardown: sidecar Vitest runs ensure the sidecar with preparation phases broadcast on `run-status` mode `docker`; ensure failure → `{ ok: false, reason: 'docker-unavailable' }`, no spawn, `run-status` running false; local-mode and no-docker-backend Vitest runs never touch the sidecar; `dispose()` and the stop force-kill path call sidecar disposal even with no child running. Verify: `cd tests && bun test run-controller.test.ts` (new cases fail)
- [x] 3.4 Implement `prepareRun()`, `dispose()`, and the force-kill path to green. Verify: `cd tests && bun test run-controller.test.ts` + `bun run typecheck`

## 4. Schema, client, and wiring

- [x] 4.1 Write failing test in `tests/run-request-schema.test.ts`: `RunResponseSchema` accepts `docker-missing-browser-hook` and rejects `docker-unsupported-for-runner`; swap the literal in `src/schemas/http.ts` and the `StartResult` union in `src/server/run-controller.ts`. Verify: `cd tests && bun test run-request-schema.test.ts run-controller.test.ts` + `bun run typecheck`
- [x] 4.2 Map the `docker-missing-browser-hook` reason to a message naming the `CRVY_RPRTR_BROWSER_WS` snippet and the docs page in `src/client/App.svelte` (replacing the docker-unsupported string). Verify: `bun run build` + `bun run typecheck`
- [x] 4.3 Wire the sidecar through `resolveRunBackend` (`src/server/launcher-resolver.ts`) → `setupRoutesContext` (`src/server/app.ts`) → `createRunControllerAndHandlers` (`src/server/server-factories.ts`), passing docker options/exec and preserving Playwright behavior. Verify: `cd tests && bun test run-launcher.test.ts server-routes.test.ts` + `bun run typecheck`

## 5. Example and docs

- [x] 5.1 Add the documented `provider: playwright({ connectOptions: ... })` snippet (env-gated on `CRVY_RPRTR_BROWSER_WS`, `exposeNetwork: '<loopback>'`) to `examples/vitest-browser/vitest.config.ts` and surface it in the example README. Verify: `bun run example` (example suite still runs locally) + `bun run typecheck`
- [x] 5.2 Update `docs/docker-screenshot-determinism.md` with the Vitest sidecar section (managed sidecar, env snippet, CI via consumer-owned sidecar) and `docs/docker-manual-smoke-test.md` with the Vitest sidecar procedure and pass criteria. Verify: docs read consistently with the implementation; no code impact

## 6. Full gate

- [x] 6.1 Run the full gate: `bun run check` and `bun run test:playwright` (UI run-status/client message changed); fix any fallout. Verify: both commands exit 0
