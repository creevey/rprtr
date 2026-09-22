# Tasks

## 1. Gateway contract

- [x] 1.1 Add failing cases to `tests/docker-launcher.test.ts` for the docker arg vector: it contains `-e CRVY_RPRTR_DOCKER=1` and `-e CRVY_RPRTR_HOST_GATEWAY=host.docker.internal` next to the existing env flags; a local launch sets neither; a host environment that defines either name does not cause it to be forwarded (denylist). Verify: `bun run build && cd tests && bun test docker-launcher.test.ts` fails on the new assertions.
- [x] 1.2 Implement the contract in `src/server/docker-run-args.ts` and add both names to `ENV_DENYLIST` in `src/server/docker-env.ts`. Verify: `bun run build && cd tests && bun test docker-launcher.test.ts` passes and `bun run typecheck` is clean.

## 2. Config introspection

- [x] 2.1 Add a failing unit test `tests/config-dump.test.ts` for the generated reporter module: it declares `version() === 'v2'`, writes `{ webServers, projects: [{ name, baseURL }] }` for a config with single-object and array-form webServers (array reached through a `configInternalSymbol` fixture) and project baseURLs, omits missing fields, and never throws on a malformed config. Verify: `bun run build && cd tests && bun test config-dump.test.ts` fails.
- [x] 2.2 Implement `src/server/config-dump.ts`: the reporter source constant, `ensureConfigDumpReporter()` writing it to a stable temp path (fontconfig pattern), a Zod schema for the parsed dump, and a read-and-delete helper. Verify: `bun run build && cd tests && bun test config-dump.test.ts` passes and `bun run typecheck` is clean.
- [x] 2.3 Add failing cases to `tests/docker-preflight.test.ts` (or `tests/playwright-discovery.test.ts` for the shared spawn helper): the docker preflight listing spawn passes `--reporter=json,<generated path>` and `CRVY_RPRTR_CONFIG_DUMP=<temp file>`, parses the dump alongside the browser pins, and degrades to no summary when the dump is missing or malformed. Implement in the `src/project-pins.ts` spawn options and the preflight input reader. Verify: `bun run build && cd tests && bun test docker-preflight.test.ts playwright-discovery.test.ts` passes.
- [x] 2.4 Add a real-listing integration test against a fixture project `tests/fixtures/webserver-array/` whose `playwright.config.ts` declares a two-entry `webServer` array; the dump contains both entries when listed through the project's own Playwright. Verify: `bun run build && cd tests && bun test config-dump.test.ts` passes.

## 3. Divergence diagnostic

- [x] 3.1 Add failing matrix tests to `tests/docker-preflight.test.ts` for the host-service diagnostic with an injected probe: loopback webServer with reuse intent and an answering host warns; array entry is named; uncovered loopback baseURL warns; a baseURL served by a webServer entry is not double-reported; gateway address with no host service warns; no warning without divergence; unresolvable config produces nothing; 404-at-`/` + 200-at-`/index.html` counts as available; userinfo and token query are stripped from the message. Verify: `bun run build && cd tests && bun test docker-preflight.test.ts` fails.
- [x] 3.2 Implement the probe (HTTP below 404, `/` 404 retried at `/index.html`, TCP for port-only entries, short timeout; gateway probed by gateway hostname then loopback alias) and the three message templates with URL sanitization in `src/server/docker-preflight.ts` (split to a sibling module if project limits demand). Verify: `bun run build && cd tests && bun test docker-preflight.test.ts` passes and `bun run typecheck` is clean.
- [x] 3.3 Add a failing case to `tests/docker-launcher.test.ts` that the docker launcher exposes the per-run diagnostic from its prepared state; implement the cached summary in the launcher state and the optional diagnostic on `RunLauncher` (`src/server/docker-launcher.ts`, `src/server/run-launcher.ts`). Verify: `bun run build && cd tests && bun test docker-launcher.test.ts run-launcher.test.ts` passes.
- [x] 3.4 Add a failing case to `tests/run-controller.test.ts` that `prepareRun` collects diagnostic notices for a docker context; wire it through `src/server/run-preparation.ts` and `src/server/run-controller.ts`. Verify: `bun run build && cd tests && bun test run-controller.test.ts` passes.

## 4. Live UI notice

- [x] 4.1 Add a failing schema case to `tests/schemas.test.ts` that `run-status` accepts an optional `notices: string[]` and still accepts payloads without it; update `src/schemas.ts` and `src/types.ts`. Verify: `bun run build && cd tests && bun test schemas.test.ts` passes and `bun run typecheck` is clean.
- [x] 4.2 Add a failing case to `tests/run-controller.test.ts` that the running broadcast after a warned prepare carries the notices; implement the plumbing in `src/server/run-controller.ts` and log each notice through the warning sink. Verify: `bun run build && cd tests && bun test run-controller.test.ts` passes.
- [x] 4.3 Render the notices in the sidebar: `src/client/App.svelte` keeps them for the current run and `src/client/components/Sidebar.svelte` displays them next to `runMessage`; clear them when the next run starts. Verify: `bun run build && bun run typecheck` is clean and `bun run test:playwright` exercises the run controls without regressions.
- [x] 4.4 Add a regression assertion that notices never reach report persistence or artifacts: after a warned prepare/start cycle the controller's report setters see only running flags, and `bun run build && cd tests && bun test report-persistence.test.ts offline-artifact.test.ts` stays green.

## 5. Docs

- [x] 5.1 Write `docs/docker-host-services.md`: silent reuse/start behavior, the three divergence cases, the `CRVY_RPRTR_DOCKER` / `CRVY_RPRTR_HOST_GATEWAY` recipe (derive `webServer.url` and `baseURL`, fall back to `localhost`), and the platform matrix (Linux requires a `0.0.0.0` host bind; Docker Desktop reaches loopback-only host services). Verify: `bun run format:check`.
- [x] 5.2 Update the README Docker Mode note ("that server now starts inside the container") and add the troubleshooting row to `docs/docker-manual-smoke-test.md`, both pointing at the new page. Verify: `bun run format:check`.

## 6. Full verification

- [x] 6.1 Run the complete gate and browser suite: `bun run check` and `bun run test:playwright`, confirm all tasks above are checked off and the docs from section 5 are updated. Fix any surfaced issues before declaring the change complete.
