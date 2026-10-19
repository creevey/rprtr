# Tasks

## 1. Probe seam

- [x] 1.1 Write failing tests in `tests/docker-preflight.test.ts` for the new `hostHeader` probe seam: the default probe sends the supplied `Host` value to a real loopback HTTP server and returns its status, returns null on a connection failure, and gives up after a whole-request timeout. Verify: `bun run build && cd tests && bun test docker-preflight.test.ts` (new cases fail).
- [x] 1.2 Add `hostHeader(url, host)` to `HostServiceProbe`, implement the `node:http`/`node:https` default with the whole-request timeout and no redirect following, move the probe seam and defaults into `src/server/host-service-probe.ts` to stay under the file-size limit, and fill it in `resolveProbe`. Verify: task 1.1 tests pass; `cd tests && bun test docker-preflight.test.ts docker-launcher.test.ts`.

## 2. Refusal diagnostic

- [x] 2.1 Write failing tests in `tests/docker-preflight.test.ts`: a reachable gateway address answering `403` for the gateway hostname and `200` for the loopback name yields one notice naming the address, the rejected hostname, `allowedHosts`, and the docs path; a non-403 gateway answer yields none; `403` for both names yields none; an unreachable address keeps the existing "nothing answers" notice and issues no host-header request; loopback `webServer`/`baseURL` candidates never issue a host-header request. Verify: `cd tests && bun test docker-preflight.test.ts` (new cases fail).
- [x] 2.2 Implement the differential check in the gateway branch of `diagnoseCandidate`: issue the gateway-hostname request, short-circuit unless it is `403`, issue the loopback control request, and emit the notice on divergence with sanitized address text. Verify: task 2.1 tests pass.
- [x] 2.3 Add a `tests/docker-launcher.test.ts` case proving the notice reaches `launcher.diagnose()` through the injected probe seam for a prepared config summary. Verify: `cd tests && bun test docker-launcher.test.ts`.

## 3. Docs and gate

- [x] 3.1 Update `docs/docker-host-services.md`: add the refusal case to the warning table, replace the "probes cannot see an HTTP-level refusal" caveat with the new differential check, and keep the `curl` verification snippet. Verify: `bun run format:check`.
- [x] 3.2 Update the `docs/docker-manual-smoke-test.md` troubleshooting row for Storybook `403` to name the new notice. Verify: `bun run format:check`.
- [x] 3.3 Full gate: `bun run check`, and `bun run test:playwright` because the notice rendering path is unchanged but the client is rebuilt. Verify: both exit 0.
