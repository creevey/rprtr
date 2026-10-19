# Proposal

## Why

A docker-mode run that addresses a host dev server through the gateway hostname can fail every test with navigation timeouts while nothing points at the cause: the dev server's own `Host` check rejects `host.docker.internal` with `403`, Playwright's readiness rule counts any status below 404 as available, and rprtr's preflight mirrors that rule. The run starts, reuses the server, and every `waitForSelector` times out against the server's plain-text error page. `docker-host-services` already owns the host-side probing and the non-blocking notice channel for exactly this situation; it cannot see this case today because it judges networking only.

## What Changes

- The host-service probe gains an HTTP request with an explicit `Host` header, so the diagnostic can ask a host service how it answers the hostname the container will send.
- The divergence diagnostic gains one case: a host-gateway address that answers on the host, refuses the gateway hostname with `403`, and accepts the host's loopback name. The notice names the address, explains that tests will see the server's error page, and names the fix (allow the gateway hostname — Storybook `core.allowedHosts`, Vite `server.allowedHosts` — or bind with `--host 0.0.0.0`).
- The check stays non-blocking and terminal/UI-only: the run still starts, and nothing is written to `report.json`, offline JSON reports, or the static HTML artifact.
- `docs/docker-host-services.md` and the smoke-test troubleshooting table describe the new notice and drop the claim that a host check is invisible to the probes.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `docker-host-services`: the divergence diagnostic gains the host-header refusal case, its differential probe semantics, and the notice wording; the delivery and persistence requirements are unchanged because the notice rides the existing preparation channel. Without it, a 403 host check stays indistinguishable from a slow or broken app.

## Non-goals

- Refusing or blocking the run on a host-check refusal; the capability contract stays warn-only.
- Detecting refusals other than `403`, or a server that refuses both the gateway hostname and the loopback name (auth, ACL, IP allowlists).
- Probing addresses the container does not reach through the gateway hostname: loopback `webServer`/`baseURL` addresses keep their existing masked/uncovered notices.
- Reporter-side detection inside the container, and any change to run semantics, artifacts, or the live UI transport.
- The planned sidecar migration; `playwright-docker-browser` retires this diagnostic, so this change targets the current in-container docker line and must land before it.

## Impact

- Code: `src/server/docker-host-services.ts` (probe seam and diagnostic), `src/server/docker-launcher.ts` (seam pass-through unchanged).
- Tests: `tests/docker-preflight.test.ts`, `tests/docker-launcher.test.ts`.
- Docs: `docs/docker-host-services.md`, `docs/docker-manual-smoke-test.md`.
- Published surface: no new exports, flags, modes, or dependencies; `HostServiceProbe` is internal.
