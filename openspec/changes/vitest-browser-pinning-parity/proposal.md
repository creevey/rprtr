# Proposal: vitest-browser-pinning-parity

## Why

Browser pinning shipped Playwright-only: the archived `browser-pinning` change listed "Vitest reporter parity" as a fast-follow non-goal. Vitest Browser Mode is a first-class rprtr runner with its own Docker sidecar path, so the rendering drift the capability exists to catch is unattributable on Vitest runs — and `crvy-rprtr browsers check --strict`, the CI gate the README tells teams to run, prints "No browser pins declared" for a Vitest-only project and silently passes.

## What Changes

- The Vitest reporter options gain the Playwright pin model: `browserPin` (fallback for every browser project the reporter sees) and `browserPins` (keyed by Vitest project name — Vitest creates one project per browser instance, e.g. `desktop (chromium)`), plus `browserPinPolicy: 'warn' | 'fail'`. Pins are Zod-validated at reporter init; an invalid pin or a declared browser that disagrees with the project's configured browser fails initialization. A `browserPins` key that matches no project of the current run is ignored with one warning, because per-test reruns filter projects with `--project`; `browsers check` reports keys that match no configured project.
- For every pinned Vitest project the reporter resolves the effective build offline and records `playwrightVersion`, browser build/revision, pin status, and the Docker image when the run uses the managed sidecar. Local runs resolve from the project's installed `playwright` package; sidecar runs resolve from the pinned image derived from that same install.
- Unverifiable instead of drift: non-playwright providers, remote `connectOptions.wsEndpoint` targets, `launchOptions.channel`/`executablePath`, and custom Docker images — the reporter cannot observe those builds.
- Existing surfaces carry the environments unchanged: register/run-end payloads feed the live UI, the static `crvy-rprtr.html` artifact, and offline JSON reports; drifted tests are marked in the sidebar. Legacy artifacts stay loadable.
- `crvy-rprtr browsers check [--strict]` reads Vitest pins in addition to Playwright pins by evaluating the project's own Vitest config through its own Vitest, so `--strict` gates Vitest drift too. `browsers resolve` resolves the project's `playwright` for installed-environment state when `@playwright/test` is absent.
- Docker mode preflights Vitest pins before the browser sidecar container starts — a drifting pin rejects the run with the matching image tag as the remedy. The server passes the resolved image to the spawned Vitest process so sidecar runs carry their provenance.
- Docs: README Browser Pinning and Vitest Reporter Options, plus `docs/docker-screenshot-determinism.md`.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `browser-pinning`: declaration, run environment resolution, unverifiable environments, policy/diagnostics, output-surface provenance, CLI check/resolve, and Docker preflight requirements are extended from Playwright-only to cover Vitest Browser Mode through the reporter options above. The existing implementation modules — `src/browser-pins.ts`, `src/reporter-environments.ts`, `src/project-pins.ts`, `src/server/docker-preflight.ts` — are extended, not replaced. `vitest-docker-browser` requirements do not change; its sidecar image contract is reused as the drift remedy.

## Impact

- Reporter: `src/vitest.ts`, `src/vitest-options.ts`, new shared Vitest pin module; `src/browser-pins.ts`/`src/playwright-install.ts` gain runner-neutral resolution helpers.
- Server/CLI: `src/project-pins.ts` (or a Vitest sibling) config reader, `src/cli-browsers.ts`, `src/server/run-controller.ts`, `src/server/vitest-backend.ts`, `src/server/docker-preflight.ts`.
- Published surface: Vitest reporter options only; `./vitest` export, package `exports`, bin, and dependencies unchanged. `@playwright/test` and `vitest` remain optional peers.
- No snapshot path, baseline, or approval behavior changes.
- Tests: new Vitest pin/reporter tests plus CLI, preflight, and run-controller coverage.
- Docs: README, `docs/docker-screenshot-determinism.md`.

## Non-goals

- Verifying builds the reporter cannot observe: webdriverio and custom providers, self-managed remote endpoints, custom Docker images, branded channels, explicit executables.
- Launching browsers to query versions; resolution stays offline and declaration-time.
- Changing Playwright pin behavior, the pin declaration surface, or the build map.
- Pins for Vitest projects that do not run the rprtr reporter — there is no declaration surface without it.
- Baseline sidecar files and blocking approvals on pin status.
