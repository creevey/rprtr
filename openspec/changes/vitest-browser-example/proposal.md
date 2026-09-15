# Proposal: vitest-browser-example

## Why

Vitest Browser Mode support shipped (live reporting, offline artifacts, approvals via `vitest-browser-reporter` + `vitest-approval`), but the only working setup lives in an internal test fixture (`tests/fixtures/vitest-browser/`) and prose in README. A user cannot copy a runnable, annotated project. The Playwright Component Testing example (`examples/component-testing`) proved this docs-example pattern and is already installed and linted in CI; Vitest deserves the same.

## What Changes

- Add a self-contained example project `examples/vitest-browser/`:
  - `vitest.config.ts` — Browser Mode with `@vitest/browser-playwright` provider and `CrvyRprtrVitestReporter` from the published `@crvy/rprtr` package (`^0.3.x`, same sourcing as the component-testing example).
  - Framework-free vanilla DOM components (keeping the component-testing example's "no framework, every piece visible" philosophy) and tests using `toMatchScreenshot()` plus one plain DOM assertion.
  - Committed baselines for `darwin` and `linux` so the suite is green on both immediately.
  - Annotated `README.md`: quickstart (reporter + test terminals), first-run baseline behavior, the live diff → Approve loop, `test:ci` offline artifacts, `update-snapshots` (`vitest run --update`), and honest limitations (no docker runs, no UI run buttons until `vitest-runner` lands).
- Root `package.json` gains an `example:vitest` script alongside `example` / `example:ct`.
- CI workflows (`ci.yml`, `publish.yml`) install the example dependencies like `examples/component-testing`.
- Main `README.md` links the example and removes the stale "Approving Vitest screenshots is not supported yet" limitation (shipped in `vitest-approval`).

## Capabilities

### New Capabilities

_None._ This change adds documentation/tooling only; it introduces no product behavior and no consumer-visible surface changes. Per validation rules this change opts out of specs via `skip_specs: true` in `.openspec.yaml`.

### Modified Capabilities

_None._

## Impact

- **New**: `examples/vitest-browser/**` (package.json, vitest.config.ts, src/, tests/, baselines, README).
- **Modified**: root `package.json` (script), `.github/workflows/ci.yml` + `publish.yml` (example install/lint step), `README.md` (link + stale-limitation fix).
- **No product code changes**: reporter, server, client, exports map, wire format, and peer dependencies are untouched. Verification is running the example (`bun run example:vitest` flows) plus `bun run check`.

## Non-goals

- No UI run buttons for Vitest — that is the separate `vitest-runner` change; this example works in either order and documents the terminal workflow.
- No docker-mode support for Vitest runs in the example.
- No React/Vue/Svelte variants of the example.
- No reporter/server feature work or bug fixes — the example pins the published npm package, so new product features reach it only after the next publish.
