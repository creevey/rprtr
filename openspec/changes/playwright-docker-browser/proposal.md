# Proposal

## Why

Playwright docker mode runs the test process, browsers, and reporter inside the container, so on Linux (Docker Engine) a host dev server bound to `127.0.0.1` is unreachable — the container knocks on the bridge gateway and loopback does not answer. Vitest docker mode already avoids this by keeping the test process on the host and exposing host loopback to the containerized browser (`exposeNetwork: '<loopback>'`, `docs/docker-manual-smoke-test.md` S13). Docker mode should mean the same for both runners: browsers from the pinned image, not the test process.

## What Changes

- **BREAKING**: Playwright `--run-mode docker` runs `playwright test` on the host against the managed `playwright run-server` sidecar (`PW_TEST_CONNECT_WS_ENDPOINT` plus `PW_TEST_CONNECT_EXPOSE_NETWORK`), replacing in-container execution. No new mode value.
- Host loopback services become reachable from the containerized browser by construction: no gateway recipe, no `0.0.0.0` rebind, no host-side bridge; `webServer` runs on the host.
- Reuse the sidecar lifecycle (image pin, pull/reuse, readiness, dispose), rendering pins, and loopback-only endpoint; artifacts and reports stay host-side with host paths.
- Retire the docker gateway contract and the host-service divergence diagnostic: with no in-container test process, nothing exports `CRVY_RPRTR_DOCKER`/`CRVY_RPRTR_HOST_GATEWAY` and no divergence remains.
- Keep `docker.image`, `docker.platform`, `docker.extraArgs`, and font rendering as sidecar inputs; the in-container entry-command option no longer applies.

## Capabilities

### New Capabilities

- `playwright-docker-browser`: docker-mode Playwright runs driven from the host against image-pinned container browsers over a loopback-exposing connection — launch composition, reachability, host-side artifacts, routing/refusal/status. Without it, Linux users must rebind or bridge host services.

### Modified Capabilities

- `vitest-docker-browser`: generalize the sidecar lifecycle, image-pin, rendering, and host-artifact requirements to the shared browser-sidecar contract both runners use; the loopback-only endpoint and Vitest hook requirements already apply unchanged. Without it, the Playwright path duplicates or drifts from the contract.
- `docker-host-services`: remove the gateway contract and divergence diagnostic; no in-container Playwright run remains to consume them, and keeping them would claim behavior the product no longer has.
- `test-runner`: route Playwright docker runs through the sidecar and generalize sidecar mode/preparation status. Without it, the docker mode's Playwright behavior and UI mode reporting are unspecified.

## Non-goals

- Preserving in-container Playwright execution, its gateway contract, or its diagnostics — superseded by this change.
- Host-side loopback bridging or automatic `webServer`/`baseURL` rewriting.
- Vitest behavior changes: the sidecar is reused, not reworked.
- Branded browser channels or non-Playwright providers through the sidecar.
- New run modes, CLI mode values, or UI mode badges.

## Impact

- Code: reuse `src/server/browser-sidecar.ts`; retire `src/server/docker-launcher.ts`, `docker-run-args.ts`, `docker-env.ts`, `docker-host-services.ts`, and `src/docker-contract.ts`; launch planning in `run-controller.ts`, `run-preparation.ts`, `run-launcher.ts`; a snapshot-suffix decision, since the host process now drives container browsers.
- Migration: configs using the documented `CRVY_RPRTR_HOST_GATEWAY ?? 'localhost'` recipe keep working (the variable is unset on the host); configs hardcoding `host.docker.internal` need a host-resolvable URL or an exposure rule (design).
- Docs: replace `docs/docker-host-services.md` with a short, task-first page that answers "what do I add, and where" — by default nothing: the connection arrives through Playwright's own `PW_TEST_CONNECT_WS_ENDPOINT` / `PW_TEST_CONNECT_EXPOSE_NETWORK` env vars, and host services stay on the host. List only the settings that remain and where they live (`--run-mode`, `--docker-image`, `--docker-platform`, `--font-rendering`; `startServer({ docker: { image, platform, extraArgs }, fontRendering })`), note that the injected connection wins over a config-declared `use.connectOptions`, cover the one-time `snapshotPathTemplate` choice for cross-host baseline names together with its effect on approval resolution, and drop the gateway recipe, `0.0.0.0` bind, and Storybook `allowedHosts` guidance. Keep the README Docker Mode section and the matching parts of `docs/docker-manual-smoke-test.md` and `docs/docker-screenshot-determinism.md` equally short and aligned.
- Surface: `--run-mode docker` semantics change for Playwright (**BREAKING**); no new modes, exports, bins, or peer dependencies.
