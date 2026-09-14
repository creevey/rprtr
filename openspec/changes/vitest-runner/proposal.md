# Proposal: vitest-runner

## Why

rprtr's core loop is review → approve → re-run from the UI. Playwright users get this: the sidebar Start/Stop and per-test ▶ buttons spawn `playwright test` (`RunController`). Vitest Browser Mode users do not — the Vitest reporter registers only artifact directories (no `configFile`/`cwd`), so no run context ever exists and the UI hides the buttons (`src/vitest.ts` `sendRegister` vs `src/server/handlers.ts` `handleRegister`). Vitest users must leave the UI and run `vitest` in a terminal; even if a context existed, `RunController.buildPlaywrightArgs` emits Playwright-only flags.

## What Changes

- Register payload gains explicit runner identification: the Vitest reporter sends `configFile` (from the resolved Vitest/Vite config), `cwd` (project root), and `runner: 'vitest'`. Additive optional fields; old reporters and old servers replay unchanged (new server + old Vitest reporter keeps today's no-buttons behavior).
- `handleRegister` builds a run context from a Vitest register the same way it does for Playwright's.
- `RunController` branches on runner kind: Vitest runs spawn `vitest run --config <file>`; update mode maps to `--update`; per-test filtering maps to file filter + `-t <title pattern>` (Vitest has no `--test-list`). Playwright arg building, including its version-gated `--test-list`, is unchanged.
- Docker mode stays Playwright-only: a Vitest run request under docker mode resolves to the local launcher (or fails with a clear diagnostic), never a Playwright container.
- No UI changes — buttons already render from `runEnabled`/`runMode`. No reporter changes needed for connectivity: `buildSpawnEnv` exports `CRVY_RPRTR_SERVER_URL`, which the Vitest transport already consumes as fallback.

## Capabilities

### New Capabilities

- `test-runner`: the provider-agnostic contract for UI-triggered test runs — how the server learns which runner kind to launch (register metadata), how update mode and per-test filters map per provider, that Playwright and Vitest runners are both launchable, and that a run request without a registered runner fails with `no-config`. No existing capability spec covers run triggering (`openspec/specs/` is empty; Playwright run buttons exist as behavior in `src/server/run-controller.ts`, not as spec) — same precedent as `screenshot-approval`, which created one provider-agnostic approval contract instead of a Vitest-only duplicate. Without it, Vitest users cannot re-run from the UI and future runners have no contract to extend.

### Modified Capabilities

_None._

## Impact

- **Code**: `src/schemas.ts` (`RegisterDataSchema.runner`), `src/vitest.ts` (register payload), `src/server/handlers.ts` (run context from Vitest register), `src/server/run-controller.ts` (Vitest arg builder), `src/server/run-launcher.ts` / `app.ts` (force local for Vitest).
- **Public surface**: no new exports; additive optional wire field; CLI `--config` remains Playwright-specific (documented).
- **Docs**: `README.md` — Vitest Browser Mode limitations list (drop "The UI does not launch Vitest runs", document the buttons); run-button section notes both providers.

## Non-goals

- Docker mode for Vitest runs (image would need vitest + browser provider; later extension of `test-runner`).
- Watch-mode launches — one-shot `vitest run` only.
- Exact per-test selection for Vitest (`-t` title-pattern matching is approximate by design; Playwright's `--test-list` precision is unchanged).
- Custom Vitest `resolveScreenshotPath`/`resolveDiffPath` resolvers (already unsupported by the reporter).
- Other runners (jest, etc.).
