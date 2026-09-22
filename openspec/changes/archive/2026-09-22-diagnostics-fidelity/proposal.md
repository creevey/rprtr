# Proposal

## Why

Two diagnostics gaps let a failing run look healthy or fail silently. On Linux (Docker Engine), the docker host-service probe treats a loopback-only host service as reachable through the gateway because the loopback alias answers, so a config that adopted the documented `CRVY_RPRTR_HOST_GATEWAY` recipe is never warned even though the container cannot reach host loopback — the run fails or times out with no notice. Separately, every server-launched run replaces Playwright's reporters with the crvy-rprtr reporter alone, and that reporter drops Playwright's fatal error reports and `webServer` process output, so the terminal shows nothing while the UI says "see the server terminal for details".

## What Changes

- The docker host-service divergence probe becomes reachability-faithful per host platform: a gateway address is available when it answers at the gateway hostname, at one of the host's non-loopback IPv4 addresses, or — only on Docker Desktop hosts (macOS/Windows) — at the loopback alias. On Linux, a service that answers only on loopback produces a new warning naming the loopback-only bind and the `0.0.0.0` remedy, instead of silence.
- The Playwright reporter forwards fatal error reports (`onError`) and runner process output (`onStdOut`/`onStdErr`) to the server terminal, so a failed run explains itself again when crvy-rprtr is the only reporter.
- Docs: `docs/docker-host-services.md` platform matrix and probe semantics.
- Tests: a platform matrix for the gateway probe with injectable platform/interface seams, and reporter passthrough tests with injectable write seams.

## Capabilities

### New Capabilities

- `run-output`: keeps the runner's own terminal output and fatal error reports visible when crvy-rprtr is the sole configured reporter, so a run that fails before or outside test execution is diagnosable from the server terminal. Without it, server-launched runs keep dropping Playwright's `onError`/`onStdOut`/`onStdErr`. No existing capability covers this: `run-lifecycle` scopes results, `test-runner` maps launch commands and discovery, and `vitest-reporter` covers Vitest events only.

### Modified Capabilities

- `docker-host-services`: the gateway-address rule of "Docker-mode host-service divergence diagnostic" changes — availability is judged from what the container can reach, not from whether the host answers at loopback; a loopback-only answer on Linux becomes a warned divergence with a bind remedy.

## Non-goals

- Surfacing fatal errors in the live UI (a new event and schema); this change restores the terminal only.
- Vitest reporter output changes; Vitest reporters are additive and do not suppress the runner's default output.
- Automatic config rewriting or loopback bridging; the gateway contract stays opt-in in the project config.
- Probing reachability from inside a container, or across custom Docker networks.
- Changing Docker Desktop's loopback-forwarding behavior.

## Impact

- Code: `src/server/docker-host-services.ts` (platform-aware probe and the loopback-only notice), the platform seam passed by `src/server/docker-launcher.ts`, `src/reporter.ts` (error/stdio passthrough plus write seams), and a small formatting helper.
- Docs: `docs/docker-host-services.md`.
- Published surface: no new exports, bin entries, or peer dependencies.
