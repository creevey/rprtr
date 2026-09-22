# Design: vitest-browser-pinning-parity

## Context

See `proposal.md` — Why and `specs/browser-pinning/spec.md` for the contract. The Playwright half is implemented and is the pattern to mirror:

- `src/browser-pins.ts` owns the runner-neutral core: `matchesVersionPrefix`, `resolveProjectPins` (metadata reader), `resolveProjectEnvironment` (revision → version → status), `evaluateBrowserPinPolicy`, and `checkDockerPins`.
- `src/playwright-install.ts` resolves the installed manifest, Playwright version, and executable paths offline via `createRequire(cwd)` + `playwright-core/browsers.json`.
- `src/reporter-environments.ts` resolves environments at `onBegin` and throws on `fail`; `src/reporter.ts` sends the map in the register and run-end payloads. Wire schemas, `src/report-state.ts`, the client badge helpers, the static artifact, and offline reports are already environment-generic.
- `src/project-pins.ts` reads Playwright pins by spawning `playwright test --list --reporter=json`; `src/cli-browsers.ts` and `src/server/docker-preflight.ts` consume its `ResolvedProjectPin[]`.

Vitest facts this design depends on (verified against installed 4.1.11):

- Vitest resolves one project per browser instance: `testCase.project.name` is the instance project's name (`desktop (chromium)`, or `chromium` when the config has no name); `project.config.browser.name` is the engine and `project.config.browser.instances` is empty on the clone. `TestProject.config.browser.provider` exposes the provider name and its options (`launchOptions`, `connectOptions`).
- The reporter's `onInit(vitest)` runs before any browser starts and exposes `vitest.projects` and the resolved `vitest.config`; the reporter runs in the Vitest main process, so `onInit` may throw to fail the run.
- `vitest/node` exports `createVitest`, which resolves the config and the instance projects (via the project's own Vite) without starting tests or browsers; `vitest.config.reporters` retains inline reporter instances, so their options are readable without invoking the reporter.
- The server's Vitest docker mode runs vitest on the host against a sidecar image `mcr.microsoft.com/playwright:v<installed playwright version>-noble` (`src/server/browser-sidecar.ts`), and already injects `CRVY_RPRTR_BROWSER_WS` into the spawned vitest process (`src/server/run-controller.ts:191`).
- `@vitest/browser-playwright` requires the project's own `playwright` package; rprtr can resolve it from the project root with `createRequire` without adding a dependency.

## Goals / Non-Goals

**Goals:**

- Vitest pins are declared in the same place the reporter is configured, so the declaration cannot drift from the run.
- The effective build is resolved offline from what the run actually launches: the project's `playwright` install locally, the version-pinned sidecar image under Docker mode.
- One shared resolver powering the reporter, `browsers check`, and the Docker preflight, so the three cannot disagree.
- Zero changes to Playwright pin behavior, the wire protocol, the client, or the snapshot/approval paths.

**Non-Goals:**

- Observing a launched browser (no `version()` call, no browser launch during resolution).
- Verifying non-Playwright providers, remote endpoints, custom images, channels, or explicit executables (spec: unverifiable).
- Project-level reporter configuration in Vitest (reporters are a root-level option; one reporter instance with a keyed map covers multi-browser configs).

## Decisions

### 1. Pins are Vitest reporter options, validated with Zod and matched by instance project name

`CrvyRprtrVitestReporterOptions` gains `browserPin?: { browser, version }` (fallback for every browser project the reporter sees), `browserPins?: Record<string, BrowserPin>` (keyed by the instance project name, matching what the sidebar labels tests with), and `browserPinPolicy?: 'warn' | 'fail'` (default `warn`). Effective pin for a project is `browserPins[project.name] ?? browserPin`.

Validation runs at `onInit` with the existing `BrowserPinSchema` and `BrowserPinValidationError`, so messages keep the Playwright shape and name the project/option and offending value. A declared browser that disagrees with `project.config.browser.name` is an invalid pin. A `browserPins` key matching no project of the current run is ignored with one warning: UI-launched per-test reruns pass `--project`, so a multi-browser config legitimately runs a subset. `browsers check` evaluates the unfiltered project set and reports unmatched keys as invalid pins, which is where typos get caught.

Alternatives rejected: a `package.json` catalog or a dedicated file (a second surface that can drift from the config that runs); scanning the config text for the option (Vitest configs are programs); keying by engine name (cannot distinguish multiple instances and breaks under filters the same way).

### 2. Extend the runner-neutral resolver; add one Vitest-specific module

`src/playwright-install.ts` gains `resolveInstalledExecutablePath(cwd, browser)` and `resolveBrowserExecutablePaths(cwd)` — `createRequire(cwd)` loading the project's `playwright` first, then `@playwright/test`. `resolveProjectEnvironment` and the policy helpers stay untouched. A new `src/vitest-pins.ts` maps a Vitest project to environment inputs:

- engine = `project.config.browser.name`; projects whose engine is not `chromium`/`firefox`/`webkit` are skipped (a pin against them is already an invalid-pin mismatch).
- provider name `playwright` required; otherwise unverifiable.
- `launchOptions.channel`/`executablePath` set → unverifiable.
- `connectOptions.wsEndpoint` set → unverifiable, except the managed sidecar (below).
- otherwise resolve the executable path from the project's installed `playwright` and call `readInstalledEnvironment({ cwd: project.config.root, browser, executablePath, pin })`.

The reporter applies `evaluateBrowserPinPolicy` per project at `onInit`: `fail` throws with the existing diagnostic (project, pin, effective build, remedy); `warn` logs one `[CrvyRprtr]` line. This is the concrete gap the Playwright-only capability left: without it, a Vitest run records nothing and `check` sees no pins.

### 3. Sidecar runs resolve from the managed image; the server passes it through

`prepareVitestRun` resolves the sidecar image before the container starts (the same `resolveDockerImage` inputs the sidecar uses) and runs the pin preflight; on success the run controller sets `CRVY_RPRTR_DOCKER_IMAGE=<image>` on the spawned vitest env next to `CRVY_RPRTR_BROWSER_WS`. The canonical tag format moves from `src/server/docker-support.ts` into a tiny shared `src/docker-image.ts` (`playwrightImageTag(version)`), used by docker-support, the sidecar, and the resolver. The reporter treats a run as sidecar-backed when `CRVY_RPRTR_BROWSER_WS` is set and the recorded image equals `playwrightImageTag(<installed playwright version>)`; then the effective build is the installed manifest's revision for that image. When the manifest entry carries platform `revisionOverrides` (WebKit in current Playwright releases) the build is unverifiable rather than risk a wrong version. Custom images, hand-set endpoints, and missing env vars are unverifiable, never drift.

Alternatives rejected: `docker exec`/`docker run` probing the image for `executablePath()` (starts containers, contradicts the no-container preflight rule, and couples the reporter to Docker); reimplementing Playwright's platform-key logic (the reason the Playwright resolver reads the effective path in the first place).

### 4. One config reader for CLI and preflight: evaluate through the project's own Vitest

`src/vitest-project-pins.ts` resolves `vitest/node` from the cwd, calls `createVitest('test', { root, config, watch: false, run: true })`, reads reporter options from `vitest.config.reporters` by duck-typing a public `declaredPinOptions()` method on instances (class identity breaks across duplicate `@crvy/rprtr` copies), maps `vitest.projects` to `ResolvedProjectPin[]`, and closes the instance in a `finally`. It never calls `standalone()`/`init()` — those initialize browser providers and launch browsers. Unmatched keys become invalid-pin entries in the returned list.

The reader is reused three ways: `browsers check` merges its pins with the Playwright reader's; Vitest Docker preflight checks them against the sidecar image with the existing `checkDockerPins`; `browsers resolve`'s installed-state probe uses `resolveBrowserExecutablePaths(cwd)`. Failures to load a config degrade (check: reports nothing for that runner; preflight: one warning), so an unresolvable config cannot block unrelated runs.

Alternatives rejected: `vite`'s `loadConfigFromFile` (does not resolve per-instance project names or workspace globs); parsing the config text (defeats typed options); spawning `vitest list --json` (lists tests, not reporter options); a new reporter entry point that prints pins (new public surface and coupling).

### 5. Surfaces reuse the existing environments plumbing unchanged

Environments are computed once at `onInit` and travel in every `register` payload (live UI) and in the run-end payload (`transport.finish`), which already feeds the static artifact and offline JSON in CI. Tests are matched to environments by `projectName`/browser label (`src/client/helpers/browser-pins.ts`), which Vitest test-begin messages already carry. No schema, client, server handler, artifact, or offline-report changes.

### 6. Published surface and dependencies

- `./vitest` export, `package.json` `exports`, bin, `dist/` layout, and both optional peer dependencies are unchanged; the new options are additive reporter options.
- No new dependency: `node:module`/`node:fs`/`node:path`, Zod, and the existing modules cover resolution and config reading; no new spawn path (the reader imports the project's Vitest in-process, mirroring how the server already runs `vitest list`).
- Docs: README Browser Pinning, Vitest Reporter Options, and Docker Mode sections; `docs/docker-screenshot-determinism.md` pin section.

## Risks / Trade-offs

- [Evaluating the Vitest config starts a Vite server (CLI `browsers check`, Docker preflight)] → only when a Vitest config is resolvable; always `close()` in `finally`; failure degrades to no pins/one warning; correctness of the run gate is worth the seconds.
- [Constructing the reporter during evaluation runs its constructor side effects (fontconfig pin)] → same effect `vitest list` discovery already has at server startup; no new behavior class.
- [Sidecar builds are resolved from the host's manifest; platform overrides could make that wrong] → manifest entries with `revisionOverrides` are unverifiable, never drift; documented as the sidecar verification boundary.
- [Filtered runs hide projects from `vitest.projects`, so keyed pins can appear unmatched] → runtime warns once and proceeds; `browsers check` validates the full config.
- [Duplicate `@crvy/rprtr` copies break `instanceof`] → options are read through a duck-typed public method, not class identity.
- [Vitest internals drift across versions] → only public `vitest/node` APIs are used (`createVitest`, `projects`, `config`), the peer range stays `>=4 <5`, and the reader is a seam with unit tests.
- [A single `browserPin` fallback in a multi-engine config fails on the non-matching project] → same behavior as a Playwright config-root pin; the message names the project and the keyed map is the remedy.

## Migration Plan

Additive. Existing Vitest configs (no new options) keep today's behavior; environments are recorded as `unpinned` for browser projects, matching Playwright's provenance. No wire, artifact, or data migration: environments are optional schemas and legacy artifacts still read as `unknown`. Rollback is reverting the commit; nothing on disk changes shape.

## Open Questions

_None._
