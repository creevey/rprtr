## Why

Vitest browser-mode runs always launch host-local browsers: explicit docker mode refuses them (`docker-unsupported-for-runner`) and auto mode warns and falls back (D5, `vitest-runner` change). Consumers whose Playwright baselines rely on docker rendering determinism get no equivalent for Vitest suites — the exact divergence docker mode exists to prevent. Vitest now documents and dogfoods the missing piece: remote browsers via `connectOptions.wsEndpoint` against a `playwright run-server` container.

## What Changes

- Docker/auto run modes route Vitest runs to **local vitest + a rprtr-managed browser sidecar** (`mcr.microsoft.com/playwright:vX-noble` running `playwright run-server`) instead of refusing or silently going local.
- Sidecar lifecycle: probe/pull image (pinned from the project's `playwright` dependency), start warm container with the existing grayscale fontconfig drop-in, loopback-only port publish, TCP readiness probe, teardown on server dispose; reuse across runs.
- Vitest config cooperation via documented env snippet (`CRVY_RPRTR_BROWSER_WS`): the user's `vitest.config.ts` sets `connectOptions.wsEndpoint` from the env when present, local launch otherwise. Explicit docker mode without a detectable hook refuses with a new reason; auto mode keeps today's warn-and-local downgrade when the hook is absent.
- `resolvePlaywrightVersion` learns the Vitest project shape (`playwright` / `@playwright/test`, no `@playwright/test` requirement).
- **BREAKING** (schema): `docker-unsupported-for-runner` refusal semantics are replaced by `docker-missing-browser-hook`; client error strings follow.
- Screenshots/baselines stay host-side (no container path mapping, no reporter URL rewrite — vitest runs on the host).

## Capabilities

### New Capabilities

- `vitest-docker-browser`: sidecar run mode for Vitest — lifecycle, image pinning, env injection, readiness, and the intra-mode screenshot determinism contract (same image + fontconfig + TZ/locale as Playwright docker mode). Without it, Vitest suites have no docker-equivalent rendering environment, so baselines captured in CI containers cannot be reproduced or approved reliably from the dev machine.

### Modified Capabilities

- `test-runner`: supersedes the unarchived `vitest-runner` delta's "Docker mode applies to Playwright runs only" requirement — docker/auto modes now produce a Vitest launch path (local vitest + sidecar) with refusal reserved for the missing-config-hook case. Without this, the UI's docker mode contract stays Playwright-only.

## Impact

- Code: `src/server/run-controller.ts` (D5 scoping), `src/server/docker-launcher.ts` + a new sidecar launcher module (reuses `docker-support.ts` exec/probe/pull machinery — extended, not duplicated), `src/schemas/http.ts` (refusal literal), `src/client` error string, `examples/vitest-browser` config snippet.
- Docs: `docs/docker-screenshot-determinism.md`, `docs/docker-manual-smoke-test.md` (new sidecar procedure), `docs/text-antialiasing-determinism.md` unchanged.
- No new npm dependencies (docker exec, p-limit, Zod already cover the need).

## Non-goals

- Containerizing the vitest process itself (Option A): host `node_modules` native bindings (rolldown) make bind-mounts unworkable without in-container installs.
- Cross-runner baseline byte-parity guarantee (Playwright ↔ Vitest): same capture path and defaults make it plausible; validated by a spike, not a contract.
- `network_mode: host`, `--inspect` workflows, headed browsers, and CDP-only containers (browserless-style; the playwright provider requires the playwright server protocol).
- Managing sidecars the consumer already runs (CI compose setups): the env snippet lets consumers own their sidecar; rprtr only manages the dev-machine one.
