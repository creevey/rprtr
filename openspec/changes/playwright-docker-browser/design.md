# Design

## Context

See `proposal.md` — Why. Today docker-mode Playwright runs are composed by `DockerLauncher` (`src/server/docker-launcher.ts`) as an in-container `playwright test` invocation with a bind-mounted project, a host-gateway contract (`src/docker-contract.ts`), host-service divergence diagnostics (`src/server/docker-host-services.ts`), and container↔host path mapping for reporter payloads and test descriptors (`src/server/docker-support.ts`). Vitest already runs on the host against a warm `playwright run-server` sidecar (`src/server/browser-sidecar.ts`), reaching host loopback through `exposeNetwork: '<loopback>'` in the project's Vitest config hook.

Constraints that shape the approach:

- Playwright reads the sidecar connection from its own environment: `PW_TEST_CONNECT_WS_ENDPOINT`, `PW_TEST_CONNECT_EXPOSE_NETWORK` (`connectOptionsFromEnv` in `playwright/lib/index.js`; verified present in published packages back to 1.38, below the `@playwright/test >= 1.40` peer floor). The environment wins over a config-declared `use.connectOptions`.
- Playwright has no supported way to override the snapshot suffix: `testInfo.snapshotSuffix` is set from `process.platform` by an auto fixture, no env/config option exists (checked 1.59/1.62/1.63 notes), and Playwright's own guidance for remote browsers is to hardcode the platform in `snapshotPathTemplate`. A probe verified that a reporter mutating `FullConfig.projects[].snapshotPathTemplate` in `onConfigure` does not reach worker snapshot paths.
- The project rejects hidden config injection: the Vitest sidecar design already rejected a generated wrapper config, and this design follows the same rule.

## Goals / Non-Goals

**Goals:**

- One warm browser sidecar serves both runners; Playwright test processes, reporters, host services, and artifacts all execute on the host.
- Keep every existing guarantee that still applies: version-pinned image, pin preflight before any container starts, loopback-only endpoint, rendering pins, preparing/refusing/status behavior.
- Remove the machinery that only existed because the test process was inside the container (gateway contract, divergence diagnostics, container path mapping, test-list path rewriting, entry-command resolution).

**Non-Goals:**

- Changing the Vitest hook contract or Vitest launch behavior.
- Rewriting, wrapping, or patching project configs to fake a container platform for snapshot names.
- Bridging host loopback explicitly, probing host services, or auto-rewriting `webServer`/`baseURL`.
- New run modes, CLI flags, public exports, bins, or peer-dependency changes.

## Decisions

### D1 — Playwright runs on the host and connects through Playwright's native environment

Docker-mode Playwright runs spawn the project's local `playwright test` with `PW_TEST_CONNECT_WS_ENDPOINT=<sidecar endpoint>` and `PW_TEST_CONNECT_EXPOSE_NETWORK=<loopback>` added to the existing local spawn environment (`buildSpawnEnv`), plus `CRVY_RPRTR_DOCKER_IMAGE` for run-environment recording. No `docker run` wraps the test process.

Alternatives considered:

- **Generated wrapper config** overriding `connectOptions`: rejected — fragile with TS/ESM/CJS configs, hides what actually runs, and the Vitest sidecar design already rejected the same approach.
- **Config hook like Vitest's `CRVY_RPRTR_BROWSER_WS`**: rejected — Playwright's native env connection needs no project cooperation, avoids a new refusal mode, and works for existing configs; the env also wins over `use.connectOptions`, so even configs that set a connection are handled.
- **`process.platform` preload override** to keep `-linux` semantics: rejected — mutates a runtime global user code observes and relies on unsupported Node behavior.

### D2 — Generalize sidecar planning instead of adding a parallel path

`vitest-backend.ts` becomes `run-backend.ts` and its backend/launch-plan resolvers take the runner kind: Playwright + docker backend always resolves to the sidecar (no hook scan), Vitest keeps today's hook/refusal/auto-downgrade behavior. `run-preparation.ts` prepares the sidecar for Playwright runs the same way it does for Vitest: pin preflight against the resolved image, then `browserSidecar.ensure` with the existing phases, returning endpoint + image. `RunController.start` injects the runner-appropriate connection variables from the prepared endpoint.

The in-container launcher (`DockerLauncher`), the docker run-arg builder, host env forwarding, the config dump, and the divergence diagnostic are deleted. `DockerOptions`, `DOCKER_WORK_DIR`, the sidecar `docker run` arg builder, and `resolveSidecarCommand` move into `browser-sidecar.ts` (the existing module for that need). `assertDockerPinsSatisfied` stays and now uses the plain Playwright listing without the config-dump reporter; the listing resolves under the host spawn environment (no gateway variables; `CI` stripped), matching what the run will load. `docker.extraArgs` — so far only honored by the in-container path — is appended to the sidecar invocation by the moved builder, for both runners.

### D3 — Drop container path mapping entirely

With the runner on the host, reporter payloads, test descriptors, test-list entries, and artifacts are host paths by construction. `routesContext.containerPathMapping`, `applyContainerPathMapping`, `rewriteContainerTestDescriptors`, the `--test-list` posix path style, and the `isContainerPath` snapshot-suffix special case are removed. `resolveBaselineSnapshotPath` keeps resolving like Playwright: project template when declared, host platform suffix otherwise.

### D4 — Snapshot naming follows Playwright's native semantics

The snapshot suffix follows the platform of the process driving the run (the host), exactly as Playwright resolves it. rprtr does not rewrite or wrap configs (D1 alternatives apply) and does not patch config objects (verified ineffective). Migration is documented, not silently absorbed:

- On Linux hosts nothing changes (`-linux` stays correct).
- On macOS/Windows hosts without a template, names carry the host platform; users who share baselines across hosts add a `snapshotPathTemplate` (or regenerate per platform).
- To make that recommendation real, the reporter and server honor a project-declared `snapshotPathTemplate`: the worker reporter falls back from its option to the resolved project value, and the register payload carries the resolved per-project templates so approval and passed-baseline resolution pick the template for the test's project. Existing reporter/server template options keep precedence.

### D5 — Keep the refusals, retire the notices

`docker-unavailable` remains the single failure reason for sidecar preparation failures and pin drift (before any container starts); `docker-missing-browser-hook` remains Vitest-only. Run-status preparation phases are emitted for both runners. The `notices` extension of run-status messages, the probe code, and the collection hooks are removed; nothing is persisted in artifact outputs either way.

### D6 — Package surface

`DockerOptions` loses `command` (the in-container entry command no longer exists) and otherwise keeps `image`, `platform`, `extraArgs`, `fontRendering`; `ServerOptions.docker` and the existing CLI flags are unchanged. No new exports, bins, modes, or peer-dependency changes. `DockerUnavailableError` moves with the sidecar module only if a public entry needs it — it is not part of the current exports map, so it stays internal.

## Risks / Trade-offs

- **Snapshot-name migration on macOS/Windows** → documented one-liner (`snapshotPathTemplate`) and template support in resolution; release note calls it out as part of the breaking change.
- **Configs that branch on the retired gateway variables** (`CRVY_RPRTR_DOCKER`, `CRVY_RPRTR_HOST_GATEWAY`) now take their host branch on the host, consistent with the run; configs hardcoding `host.docker.internal` need a host-resolvable URL — documented migration.
- **Host-service traffic tunnels through the sidecar WebSocket** (`exposeNetwork` SOCKS) instead of direct gateway access → same mechanism Vitest sidecar runs already use; acceptable at component-test scale.
- **Sidecar project mount on native Windows** stays the experimental spot (`C:\...:/work:ro`), unchanged from Vitest's existing behavior; WSL2 remains the documented recommendation.
- **A config file the pin preflight can read but the run cannot** (or vice versa) is now impossible by construction: both resolve under the same host environment.

## Migration Plan

1. Upgrade normally; run `npx crvy-rprtr --run-mode docker`. No Playwright config changes are required for the browser connection, host services, or artifacts.
2. On non-Linux hosts, choose baseline naming: regenerate baselines per host, or add `snapshotPathTemplate` (documented snippet) and keep one baseline set across hosts.
3. Remove gateway recipes when convenient — `CRVY_RPRTR_HOST_GATEWAY ?? 'localhost'` keeps evaluating to `localhost` — and replace any hardcoded `host.docker.internal` with a host-resolvable URL.
4. Rollback is reverting the release; baselines are untouched by the mode switch other than their suffix choice.

## Open Questions

None — the snapshot-suffix decision and the retired surfaces are resolved above.
