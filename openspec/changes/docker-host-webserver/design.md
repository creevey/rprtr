# Design

## Context

See `proposal.md - Why`. Constraints and existing machinery this design builds on:

- Docker mode launches `playwright test` inside the official image; the container already receives `--add-host host.docker.internal:host-gateway` and the reporter connects back over that hostname (`src/server/docker-run-args.ts`). User config URLs (`webServer`, `baseURL`) are not touched by anything.
- Playwright's webServer plugin silently reuses an available URL or silently starts `command`; only `DEBUG=pw:webserver` distinguishes them. `CI` is stripped inside the container, so `reuseExistingServer: !process.env.CI` evaluates to `true` there.
- `src/server/docker-launcher.ts` prepares docker runs once per server process (`state.prepared ??=`); `src/server/docker-preflight.ts` already resolves the project config by spawning `playwright test --list --reporter=json` (through `src/project-pins.ts`) and validates browser pins. `src/server/run-preparation.ts` runs per run request.
- The JSON list report exposes only a single-object `webServer` (`null` for arrays) and no `use.baseURL`. A spike confirmed that a `v2` custom reporter receives the plain config where `projects[].use.baseURL` is public and array-form webServers are reachable through the internal `configInternalSymbol` (verified against a two-entry array config and against a Storybook config).
- Run preparation already broadcasts `run-status` (`running`, `mode`, `phase`) to every connected browser; `src/client/App.svelte` renders `runMessage` in the sidebar. Other server warnings are console-only.
- `src/fontconfig.ts` + `src/server/fontconfig.ts` set the precedent for runtime-generated files written to a stable temp path.

## Goals / Non-Goals

**Goals**

- Give project configs a supported way to address host services from docker runs.
- Detect the three divergence cases and surface them in the live UI and server console, without blocking runs.
- Keep all probes and notices out of report state and artifacts.

**Non-Goals**

- Rewriting user configs, managing host dev servers, or bridging container loopback to the host (see proposal).
- Changing pin preflight, test discovery, or run selection behavior.
- Diagnosing hosts beyond loopback and the host gateway (LAN hostnames, service containers).

## Decisions

### 1. Gateway contract: two env vars, docker-only

`CRVY_RPRTR_DOCKER=1` and `CRVY_RPRTR_HOST_GATEWAY=host.docker.internal` are appended by `buildDockerRunArgs` next to the existing `-e` entries, and both names are added to `ENV_DENYLIST` in `src/server/docker-env.ts` so a same-named host variable cannot be forwarded and shadow them.

- Alternative: reuse `CRVY_RPRTR_DOCKER_IMAGE` as the docker marker — rejected, it is also set on the host for sidecar-backed Vitest runs.
- Alternative: `CRVY_RPRTR_RUN_MODE=docker` — rejected, Vitest sidecar runs are docker mode yet run on the host; the variable name must mean "inside the container".
- Local launcher and Vitest backend are untouched by construction (they never call `buildDockerRunArgs`).

### 2. Introspection: runtime-generated `v2` reporter on the existing preflight listing

The docker preflight spawn already loads the project config. It gains `--reporter=json,<generated reporter path>` plus `CRVY_RPRTR_CONFIG_DUMP=<temp file>`; the reporter writes `{ webServers, projects: [{ name, baseURL }] }` to that file on `onConfigure` and never throws. The generated file is a `.cjs` module written from a string constant (fontconfig precedent) to `tmpdir()/crvy-rprtr/config-dump-reporter.cjs`, so no dist entry, knip entry, or exports-map change is needed. The dump is read and deleted after the spawn; a missing dump degrades to no diagnostic.

The listing also runs with the gateway contract exported (`CRVY_RPRTR_DOCKER=1`, `CRVY_RPRTR_HOST_GATEWAY=host.docker.internal`): the summary has to reflect the container's resolution, otherwise a project using the documented recipe would be diagnosed from its host fallback (`localhost`) and warned about a divergence that does not exist.

- The reporter must declare `version() { return 'v2' }`: legacy reporters receive the config on `onBegin`, not `onConfigure`.
- Array-form webServers come from the internal `configInternalSymbol` after a description check and a structural `Array.isArray(internal.webServers)` guard; if Playwright renames the symbol, single-object webServers and `baseURL` still work and only array entries drop out.
- Alternative: parse only the JSON list report — rejected: arrays become `null` and `baseURL` is absent, which was the reason this scope was chosen.
- Alternative: deep-import Playwright's config loader — rejected: TS-config loading is Playwright-internal and version-coupled; the reporter path stays within what Playwright publicly hands reporters.

### 3. Diagnostic timing: cached config, live probe per run

The parsed summary is produced with the memoized docker prepare (same lifetime as pin validation). The probe itself runs on every run request inside `src/server/docker-host-services.ts` (split out of `src/server/docker-preflight.ts` for module limits), exported as a diagnostic the docker launcher exposes to `run-preparation.ts`; `RunLauncher` gains an optional async diagnostic hook, absent for local runs.

- Alternative: run everything inside the memoized prepare — rejected: the host service can start or stop between runs, and the warning would go stale or never appear.
- Alternative: re-list the config per run — rejected: test collection is the expensive part and config edits already require a server restart for pins; documented trade-off.
- Probe semantics mirror Playwright's own readiness check (HTTP status below 404 counts as available, 404 at `/` retried at `/index.html`; `port`-only entries use a TCP connect), with a short timeout; network failures count as "no service". Gateway addresses are probed at the gateway host first and at the loopback alias of the same port second, so a host service that binds a non-loopback interface is not falsely reported as missing.

### 4. Delivery: `run-status` notices

`run-status` data gains an optional `notices: string[]`. `RunController.prepareRun` holds the diagnostics it receives from preparation and `start()` includes them in the running broadcast (the preparation-phase broadcasts are unchanged). The client keeps the notices for the duration of the run alongside `runMessage` and renders them in the sidebar; the server also writes each notice through the existing warning sink.

- Alternative: return warnings from `POST /api/run` — rejected: the broadcast is the established preparation channel, reaches every connected browser, and already carries docker preparation state.
- Alternative: a new message type — rejected: one optional field is a smaller schema surface.
- Static HTML and offline JSON are untouched by construction: notices never enter report state (`report-state.ts` remains the only source for artifacts).

### 5. Message content and sanitization

Three templates cover the cases in the specs: masked host service (names the URL, the command, and the gateway remedy), uncovered loopback baseURL (names the origin and the remedy), gateway address with no host service (names the port and the remedy). Addresses are rendered without userinfo, query, or hash; the docs page is linked. Command text is taken from the resolved config, not from user input added at runtime.

### 6. Docs

New `docs/docker-host-services.md`: the silent reuse/start behavior, the three cases, the env contract recipe (derive `webServer.url` and `baseURL` from `CRVY_RPRTR_HOST_GATEWAY`, fall back to `localhost`), and the platform matrix (Linux requires a host bind on `0.0.0.0`; Docker Desktop reaches loopback-only host services — verified 2026-09-22 with a `127.0.0.1`-bound server and `node:22`). README Docker Mode note and `docs/docker-manual-smoke-test.md` troubleshooting row point at it.

## Risks / Trade-offs

- [Internal symbol drifts] → Description check plus structural guard; the public single-object path and `baseURL` keep working, array entries silently drop from diagnostics. Covered by a fixture test.
- [The preflight listing now carries an extra reporter] → The generated file is written synchronously before the spawn and the reporter never throws; a load failure degrades the existing pin read to its current warning path. Covered by an integration test that lists a fixture config with a `webServer` array.
- [False "gateway unreachable" warnings for host services bound to a non-loopback interface] → Probe the gateway URL, then the loopback alias; either answer counts. Documented.
- [Warning noise when a host service happens to share a port with a deliberately container-local server] → Warning only, never a refusal; the message explains both readings.
- [Config summary is cached per server run] → Same restart-to-reread behavior as browser pins; documented.
- [Secrets in URLs] → Sanitization is part of the message builder and has its own scenario; no credentials or token queries are logged or broadcast.

## Migration Plan

Additive; no config migration required. Projects that want host services adopt the two-variable recipe at their own pace; everyone else sees warnings only when the divergence is provable. Rollback is reverting the change: runs behave exactly as before, minus the notices.

## Open Questions

None.
