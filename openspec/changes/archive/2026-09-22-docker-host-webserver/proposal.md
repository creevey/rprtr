# Proposal

## Why

In Docker run mode, a project's `webServer` and `baseURL` URLs written for the host (`http://localhost:6006`) are silently reinterpreted inside the container: Playwright finds nothing on the container's own loopback and starts its own copy in-container, masking the fact that a server is already running on the host. The host is reachable — `host.docker.internal` is already wired up for the reporter link — but nothing tells the user, and the container-internal copy usually cannot even start from host-installed dependencies.

## What Changes

- Playwright docker runs gain a documented host-service contract: `CRVY_RPRTR_DOCKER=1` and `CRVY_RPRTR_HOST_GATEWAY=host.docker.internal` are exported into the container only; local and Vitest-sidecar runs never see them, so project configs can derive `webServer.url`/`baseURL` per environment.
- Run preparation gains a docker-only preflight that resolves the Playwright config through Playwright itself (array-form `webServer` and per-project `use.baseURL` included), probes the host-side services, and warns — without blocking the run — when the container will diverge from the host: a loopback `webServer` with reuse intent while the host answers, or a gateway-addressed service the host does not answer.
- The warning reaches the live UI, not just the server console: run preparation carries a notice that connected browsers display for the run.
- Docs: new `docs/docker-host-services.md` with the trap, the contract, and the Storybook recipe; `README.md` and `docs/docker-manual-smoke-test.md` updated.

Without the contract, host-run dev servers stay unreachable from docker mode (the current workaround is a second copy in the container, which macOS/Windows host installs typically cannot run). Without the preflight, the divergence stays silent: Playwright logs neither reuse nor start, and `CI` stripped inside the container flips `reuseExistingServer: !CI` to true, so the container always tries and always fails to reuse.

## Capabilities

### New Capabilities

- `docker-host-services`: host-service reachability contract and divergence diagnostics for Playwright docker runs — the gateway environment contract, the config-derived preflight, and the live-UI notice.

### Modified Capabilities

- None. `test-runner` (launch commands, selection, Vitest sidecar) and `run-lifecycle` are unaffected; docker-mode detection lives in the server modules `src/server/run-preparation.ts`, `src/server/docker-preflight.ts`, and `src/server/docker-run-args.ts`.

## Non-goals

- No automatic config rewriting: rprtr never edits `webServer`/`baseURL`; the contract is opt-in in the project config.
- No managed host dev server: starting/stopping the `webServer` command on the host, warm reuse across runs, or a sidecar-like lifecycle.
- No loopback bridging: the container does not proxy `127.0.0.1` to the host gateway.
- No changes to offline/CI artifacts, the static HTML artifact, or CLI artifact mode — no run preparation happens there.
- No new CLI flags; WSL2/native Windows behavior is untouched.

## Impact

- Code: `src/server/docker-run-args.ts` (env contract), `src/server/run-preparation.ts` / `src/server/docker-preflight.ts` (preflight), a Playwright config-dump reporter under `src/`, run-status schema and `src/client/App.svelte` (notice).
- Published surface: no new exports, bin entries, or peer-dependency changes; the contract adds two environment variable names.
- Docs: `README.md` Docker Mode notes, new `docs/docker-host-services.md`, `docs/docker-manual-smoke-test.md` troubleshooting table.
