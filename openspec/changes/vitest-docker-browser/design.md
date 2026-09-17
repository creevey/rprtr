## Context

D5 (`vitest-runner` change) scoped docker mode to Playwright because containerizing the vitest process needs an image that doesn't exist — investigation showed the real blocker is host `node_modules`: vitest 4.1's rolldown ships platform-pinned native bindings (`@rolldown/binding-darwin-arm64` only on a macOS install), so bind-mounting the project into `mcr.microsoft.com/playwright:vX-noble` fails at startup. Meanwhile vitest upstream now documents and dogfoods the browser-sidecar pattern: `playwright run-server` in a container + `connectOptions.wsEndpoint` from the vitest playwright provider (docs "Configuring Playwright"; vitest's own `test/browser/docker-compose.yaml`; `x-playwright-launch-options` header support landed in 4.1.x — verified in the installed `@vitest/browser-playwright@4.1.11`).

Verified mechanics that shape the design:

- `connectOptions` reaches the provider only via the config file — no CLI flag, no env var in 4.1.11.
- `headless` folds into `launchOptions` and auto-forwards to the server via the header, so remote runs need no extra headless config.
- `exposeNetwork` is a SOCKS interceptor (`playwright-core` `socksInterceptor.js` + `x-playwright-proxy` handshake header): browser connections to exposed hosts are tunneled through the playwright WS and dialed from the vitest host — platform-agnostic, vite stays on loopback.
- `playwright run-server` serves its endpoint on a root path (`--path` defaults to `/`) — readiness is a plain TCP probe, no log parsing.
- `toMatchScreenshot` defaults (`animations: disabled`, `caret: hide`, pixelmatch, `scale: device`) match `toHaveScreenshot` at DPR 1, and capture goes through the same playwright screenshot path.

## Goals / Non-Goals

**Goals:**

- Docker/auto modes give Vitest runs the same rendering environment (image, fontconfig, TZ/locale) as Playwright docker mode.
- Zero new npm dependencies; reuse the docker exec/probe/pull machinery and launcher seams.
- One documented config snippet that works unchanged in CI (consumer-managed sidecar via the same env var).

**Non-Goals (design-level):**

- Generated wrapper configs that inject `connectOptions` without user cooperation (rejected — see D2).
- Cross-runner baseline byte-parity as a contract (spike-validated expectation only).
- Containerized vitest, host networking, `--inspect` support, headed browsers.

## Decisions

### D1: Sidecar browser, local vitest (not containerized vitest)

Alternative rejected: running vitest inside the image like the Playwright path. Breaks on host-installed native bindings (rolldown), needs in-container installs per lockfile/package-manager (the example uses `bun.lock`; the image ships no bun), and fights upstream gravity — vitest's own CI runs the sidecar pattern. The sidecar keeps the determinism-critical part (the browser) in the image while everything else stays host-side: no path rewriting, no `ContainerPathMapping`, reporter URL stays `ws://localhost`.

### D2: Env-snippet injection, not generated wrapper config

The user's `vitest.config.ts` carries:

```ts
provider: playwright({
  connectOptions: process.env.CRVY_RPRTR_BROWSER_WS
    ? { wsEndpoint: process.env.CRVY_RPRTR_BROWSER_WS, exposeNetwork: '<loopback>' }
    : undefined,
})
```

rprtr sets `CRVY_RPRTR_BROWSER_WS` when spawning vitest in docker/auto-with-hook mode; absent env means local launch, so the same config serves CI (consumer sets the same var against their own sidecar). The wrapper-config alternative (generate a config that `mergeConfig`s the user's and overrides `provider`) was rejected: instances carrying their own provider escapes injection, dynamic import of user config paths is fragile, and it hides from users what actually runs. Detection is a textual scan of the config for the env var name: "found" always means present (no false positives), false negatives (indirect reads) only downgrade auto runs; explicit docker mode refuses with `docker-missing-browser-hook` and a message pointing at the snippet.

### D3: Sidecar command from the project mount, warm lifetime, loopback publish

`docker run -d --rm --init --ipc=host --name crvy-rprtr-browser-<pid> -p 127.0.0.1::6677 -v <fontconfig drop-in> -v <project>:/work:ro <image> node /work/node_modules/playwright/cli.js run-server --port 6677 --host 0.0.0.0` with fallbacks `playwright` → `@playwright/test` → `npx -y playwright@<version>` for projects without a resolvable local CLI. Playwright's JS is platform-pure, so a macOS mount into Linux is fine and the project's own CLI guarantees version match alongside the image tag. The host publish is ephemeral (`-p 127.0.0.1::6677`, resolved via `docker port`) — loopback-only because the root-path endpoint is a guessable browser RPC. Runs as root, matching the existing Playwright docker container posture. The container stays warm across runs; torn down on server dispose / force-kill (existing `forceRemoveContainer`). Readiness: TCP probe on the published port with timeout → `docker-unavailable` on failure. Placement: new `src/server/browser-sidecar.ts` — `docker-launcher.ts` models a per-run container driven by the Playwright arg vector; the sidecar has a different lifetime (warm), different command assembly, and no arg rewriting, so a separate module reusing `docker-support.ts` primitives is the dependency-honest split.

### D4: Networking via `exposeNetwork: '<loopback>'`, never `browser.api.host`

The snippet carries `exposeNetwork: '<loopback>'`; browser→vite traffic SOCKS-tunnels through the playwright WS and dials from the host, so vite keeps binding loopback on every platform (macOS Docker Desktop, Linux CI — no `host-gateway`, no host networking). Touching `browser.api.host` is explicitly avoided: a non-loopback bind flips vitest 4.1's `api.allowWrite`/`api.allowExec` security defaults to `false`, breaking snapshot and artifact writes. Trade-off: all module/HMR traffic flows through the WS tunnel — acceptable for component-scale suites; the spike times a cold run to quantify.

### D5: Version probe extension

`resolvePlaywrightVersion` (`docker-support.ts`) resolves `@playwright/test` only. For Vitest projects it must resolve `playwright` first, then `@playwright/test`, falling back to the explicit `docker.image` option when neither resolves — the same resolution order D3's CLI fallback uses, so image tag and in-container CLI stay consistent.

### D6: RunController re-scoping and schema surface

`resolveRunLauncher`'s D5 branch is replaced: docker/auto-with-hook Vitest runs go through the local launcher plus `CRVY_RPRTR_BROWSER_WS` in the spawn env, after `prepareRun` ensures the sidecar (probe → pull → start → ready phases broadcast on run-status). `RunResponseSchema` (`src/schemas/http.ts`) swaps the `docker-unsupported-for-runner` literal for `docker-missing-browser-hook`; the Svelte client maps it to a message naming the snippet and the docs page. Playwright paths are byte-identical to today.

## Risks / Trade-offs

- [WS-tunnel throughput bounds module serving] → Spike task times a cold sidecar run of `examples/vitest-browser`; if painful, document the cost and revisit direct networking later without contract changes.
- [Textual hook scan false-refuses exotic configs] → Refusal message names the expected env var; an `options.docker.browserEnvName` override is a safe later addition (see Open Questions).
- [Docker daemon restart orphans/destroys the warm sidecar mid-session] → Readiness is re-checked per run; a failed probe restarts the sidecar before refusing.
- [Sidecar linger after server crash] → `--rm` plus a name derived from the server PID keeps leakage bounded; `forceRemoveContainer` on dispose mirrors the existing container hygiene.
- [Image arch differences (arm64 dev vs amd64 CI)] → Same exposure as Playwright docker mode today: AA/fontconfig pinning per docs/text-antialiasing-determinism.md; `docker.platform` option already exists and applies unchanged.
- [Vitest provider version drift] → `x-playwright-launch-options` auto-forwarding requires vitest ≥ 4.1.x; older 4.x users fall back to the auto-mode warning path (scan finds the hook, provider ignores connectOptions gracefully — worst case is local launch, detectable via sidecar connection logs during the spike).

## Migration Plan

1. Ship server + client string/schema change together (single package, single publish — same rollout shape as `vitest-runner`).
2. Update `examples/vitest-browser` config to carry the snippet; extend `docs/docker-manual-smoke-test.md` with the sidecar procedure and the snippet in `docs/docker-screenshot-determinism.md`'s follow-up.
3. Rollback: revert is self-contained; the env var is inert without a docker-mode server, and the snippet degrades to local launch.

## Open Questions

- Configurable hook env name (`docker.browserEnvName`) for projects that standardize on their own variable — defer until a real consumer needs it; the refusal message already teaches the default.
- Whether auto mode should also start the sidecar eagerly at server boot (faster first run) vs lazily on first docker-mode Vitest run — lazy matches `prepareRun`'s existing shape; revisit if first-run latency matters.
