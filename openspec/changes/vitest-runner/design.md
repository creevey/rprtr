## Context

Run triggering today is Playwright-only end to end:

```
register ──▶ handleRegister (src/server/handlers.ts)
             buildRunContext only when payload has configFile + cwd
                │
                ▼
        routesContext.runContext ──▶ runEnabled (src/server/routes.ts:63) ──▶ sidebar buttons
                │
   POST /api/run { tests?, update? }
                ▼
        RunController.buildPlaywrightArgs (src/server/run-controller.ts:151)
             'test' --config <cf> [--reporter rprtr] [--update-snapshots]
             [--test-list | file:line --project=…]   (test-list gated on Playwright ≥ 1.56)
                ▼
        RunLauncher (local | docker) ──▶ spawn(cmd, args, { cwd, env: buildSpawnEnv(port) })
```

Playwright-only assumptions to unwind:

- `resolvePlaywrightLaunch` (src/server/run-launcher.ts) hard-codes the `playwright` binary.
- `buildPlaywrightArgs` hard-codes Playwright flags; `--test-list` and container path mapping are Playwright concepts.
- Startup seed discovery (src/server/playwright-config.ts `CONFIG_FILES`) checks only `playwright.config.*`; CLI `--config` is documented Playwright-specific.

Vitest-side facts that make the change small:

- `CrvyRprtrVitestReporter.onInit(vitest)` already reads `vitest.config.root`; Vite's `ResolvedConfig` exposes `configFile: string | undefined`, so the reporter can send its config path (spike: confirm the property survives Vitest's test-config merge; fall back to `vitest.vite.config.configFile` if not).
- `ReporterTransport` already resolves `serverUrl` as `options.serverUrl ?? process.env.CRVY_RPRTR_SERVER_URL ?? default` (src/transport.ts:27), and `buildSpawnEnv` strips `CI` and exports `CRVY_RPRTR_SERVER_URL` — a server-spawned Vitest run streams live with zero transport changes.
- RegisterDataSchema (src/schemas.ts) already carries optional `configFile`/`cwd`; only the `runner` discriminator is new.

Compatibility matrix:

| Server \ Reporter | Old Playwright             | New Playwright | Old Vitest                   | New Vitest                           |
| ----------------- | -------------------------- | -------------- | ---------------------------- | ------------------------------------ |
| Old server        | buttons ✓                  | buttons ✓      | no buttons                   | no buttons (strips unknown `runner`) |
| New server        | buttons ✓ (default runner) | buttons ✓      | no buttons (no `configFile`) | buttons ✓ (`vitest` runner)          |

## Goals / Non-Goals

**Goals:**

- One run-context contract covering both runner kinds, selected by an explicit register field.
- Byte-identical behavior for the existing Playwright path (args, env, docker, container mapping).
- Vitest per-test and update-mode runs from the existing UI buttons with no client changes beyond the new docker-refusal error string.

**Non-Goals:**

- Docker containerization of Vitest runs (image needs vitest + browser provider; future extension of this capability).
- Server-side auto-discovery of `vitest.config.*` (see Decision 3).
- `--test-list`-precision filtering for Vitest; watch-mode launches; other runners.
- Changes to approval routing, artifact serving, or offline/CI reporting paths.

## Decisions

### 1. Explicit `runner` discriminator over inference

`RegisterDataSchema` gains `runner: z.literal('vitest').optional()`. Absent ⇒ Playwright (preserves old-reporter behavior; Playwright reporter never sends the field). Inferring from `vitestAttachmentsDir` presence was rejected: dual-stack repos can register both artifact kinds from one payload, and a discriminator keeps future runners (`jest`, …) open without schema churn.

### 2. Config/cwd sourcing in the Vitest reporter

`sendRegister` (src/vitest.ts) extends to send `configFile` from the resolved Vite config (`vitest.config.configFile`, `string | undefined`), `cwd: this.projectRoot`, and `runner: 'vitest'` — only in the existing non-CI register path. When `configFile` is undefined (inline programmatic config), the field is omitted and the server keeps buttons hidden; documented behavior, not an error.

### 3. No Vitest config discovery at server startup

`seedRunContext` and CLI `--config` stay Playwright-only. Rationale: dual-stack repos (both `playwright.config.*` and `vitest.config.*` in one directory) are a primary rprtr audience; auto-discovery would need a tie-break rule with no honest answer. The reporter is the only source that _knows_ it is Vitest. README keeps `--config` documented as the Playwright config path.

### 4. Shared command resolution, per-runner arg builders

- Extract the package-manager resolution from `resolvePlaywrightLaunch` into `resolveLocalCommand(name, args)` in src/server/run-launcher.ts (same `getUserAgent()` sync detection, same npx fallback; the sync-detection limitation is unchanged and already documented there).
- `RunController` branches on runner kind. Vitest builder: `['run', '--config', <cf>]`, update ⇒ `--update`, per-test ⇒ positional file + `--project=<p>` when all descriptors share a project + `-t <titlePath joined with spaces>`. No `--reporter` injection (the project's Vitest config carries the reporter), no `--test-list`, no Playwright version probe. Playwright builder untouched.
- The run request already carries `titlePath` per test (src/schemas/http.ts `RunTestDescriptorSchema`), so `-t` gets the full suite-qualified name, minimizing substring collisions (Vitest matches `-t` against the full test name as substring).

### 5. Docker scoping per run mode

`RunController` learns the configured run mode (via deps alongside the launcher). For Vitest runners:

| runMode             | Behavior                                                                        |
| ------------------- | ------------------------------------------------------------------------------- |
| `local`             | local launch                                                                    |
| `auto`              | local launch + one warning line (docker skipped: Vitest runs not containerized) |
| `docker` (explicit) | fail fast, `{ ok: false, reason: 'docker-unsupported-for-runner' }`             |

Explicit-docker refusal is deliberate: silently launching host-local would produce baselines from a different rendering environment than the user's docker workflow — the exact divergence docker mode exists to prevent. `auto` falls back rather than fails because auto is the default and must not disable Vitest buttons on docker-daemon machines. `RunResponseSchema` (src/schemas/http.ts) gains the reason literal; the client adds its error message.

### 6. Environment: reuse `buildSpawnEnv` verbatim

`CI` stripped (UI-launched runs must not trip the reporter's offline mode), `CRVY_RPRTR_SERVER_URL` injected, grayscale fontconfig applied on Linux — all provider-agnostic already. One documented caveat: a reporter constructed with an explicit `serverUrl` option ignores the injected env; the README and the example config keep `serverUrl` unset for dev use.

### 7. Container path mapping left untouched

`applyContainerPathMapping` in `handleRegister` stays unconditional. It only rewrites when a docker run created a mapping, and Vitest runs can never create one (Decision 5), so Vitest registers are unaffected in practice. Adding a runner guard would be dead code.

## Risks / Trade-offs

- [`-t` substring matching can over-match similarly named tests] → the pattern includes the full title path (suite + test), which is unique in well-named suites; README documents the approximation and that Playwright keeps exact selection.
- [`vitest.config.configFile` may not surface through Vitest's merged test config] → tasks open with a spike against the existing browser fixture; fallback is `vitest.vite.config.configFile`; if neither exists the feature degrades to today's no-buttons behavior (never wrong behavior).
- [Vitest CLI flag drift] → peer dependency already gates `vitest >=4 <5`; `run`, `--config`, `--update`, `-t`, `--project` are stable v4 surface; arg builder is covered by unit tests so drift fails loudly.
- [Sync package-manager detection can't see the target project's lockfile when the server runs elsewhere] → pre-existing limitation of the Playwright path (`getUserAgent` + npx fallback), now shared; not worsened.
- [New failure reason in the `/api/run` discriminated union] → additive; UI ships with the server; offline reports and static HTML never carry run responses.

## Migration Plan

1. Land server + reporter together (single package, single publish): schema field, register payload, arg builder, docker scoping, client error string.
2. README updates in the same change: Vitest Browser Mode limitations list (drop "The UI does not launch Vitest runs"), run-buttons section naming both providers, note on omitting `serverUrl` for UI-launched runs.
3. `examples/vitest-browser` (separate `vitest-browser-example` change) documents the buttons once published; it works in either order.
4. Rollback: revert the commit — old servers strip the unknown `runner` field; old Vitest reporters with a new server keep today's hidden-button behavior. No data or wire-format migration.

## Open Questions

_None._
