## Context

The Vitest Browser Mode integration is feature-complete in the package (live reporting, offline/static artifacts, approvals), but the only runnable reference is the internal fixture `tests/fixtures/vitest-browser/` — a CI-mode, single-test harness with no README, no committed baselines, and no loop narrative. The Playwright Component Testing example (`examples/component-testing`) established the house pattern for user-facing examples: self-contained package with its own lockfile, depends on the **published npm package**, committed baselines for darwin + linux, annotated README, wired into CI installs.

Vitest specifics that shape this example (all verified against Vitest 4.1 docs and the fixture):

- Browser Mode needs no dev server, gallery, or mount contract — Vite compiles/serves test + component modules into a real Chromium instance. The example is therefore _simpler_ than the component-testing one.
- `toMatchScreenshot()` first run creates the reference **and fails the test** (Playwright-like UX); second run compares. Failure messages carry reference/actual/diff paths — exactly what `parseVitestScreenshotError` (src/vitest-helpers.ts) consumes.
- Baseline layout: `<test file dir>/__screenshots__/<test file>/<name>-<browser>-<platform>.png`; run artifacts land in `.vitest-attachments/` (gitignored).
- Update flag: `vitest run --update` (`-u`), or `u` in watch mode.

CI context: `ci.yml` already installs example deps in the lint job and runs browser tests in the official `mcr.microsoft.com/playwright:v1.59.0-noble` container — the container has Chromium and Node, so the example suite can run (and its `-linux` baselines be validated) in that job as-is.

## Goals / Non-Goals

**Goals:**

- A copy-pasteable, green-on-first-clone example demonstrating: config wiring, live reporting, first-run baseline UX, diff review + Approve, CI artifacts, `--update`.
- CI-validated example (installed, linted, and its suite executed on Linux), not just prose.
- Framework-free components so every mechanism stays visible (component-testing example philosophy).

**Non-Goals:**

- No product code changes (reporter/server/client untouched; see proposal).
- No UI run buttons narrative (that is `vitest-runner`; README documents the terminal workflow and links forward).
- No docker-mode section for Vitest runs; no React/Vue/Svelte variant; no multi-browser matrix (chromium only, keeping baselines manageable).

## Decisions

### 1. Layout mirrors `examples/component-testing`

```
examples/vitest-browser/
├── package.json          # private, own lockfile, published @crvy/rprtr
├── vitest.config.ts      # browser mode + provider + CrvyRprtrVitestReporter
├── tsconfig.json         # standalone strict config (like the CT example)
├── .gitignore            # node_modules, .vitest-attachments/, crvy-rprtr*.json/html, screenshots/
├── src/
│   ├── button.js         # factory → { root, update } (vanilla DOM)
│   └── expandable.js     # tiny stateful component
├── tests/
│   ├── button.test.ts    # DOM assertions + toMatchScreenshot('button-...')
│   └── expandable.test.ts# interaction (click) then screenshot
├── tests/__screenshots__/…-chromium-darwin.png / -linux.png   # committed
└── README.md
```

### 2. Exact-pinned dependencies

`vitest@4.1.11` + `@vitest/browser-playwright@4.1.11` (version skew between vitest and its browser provider is the top support burden; both match the repo's own devDependencies), `playwright@1.59.0` (provider launches its browsers; same version as `@playwright/test` in the repo and the CI container tag), `@crvy/rprtr@^0.3.3` from npm (same sourcing as the CT example — new product features reach the example only after publish, accepted trade-off).

### 3. Vanilla DOM components imported through Vite

Unlike the fixture's `innerHTML` string, the example imports real component modules in tests — demonstrating the module graph users actually have — while staying framework-free. Two components suffice: `button.js` (static, per-props rendering) and `expandable.js` (stateful, click interaction before screenshot) mirroring the CT example's test patterns.

### 4. Minimal reporter configuration

`new CrvyRprtrVitestReporter()` with defaults and **no `serverUrl`**: the transport's `CRVY_RPRTR_SERVER_URL` env fallback (src/transport.ts:27) keeps the config forward-compatible with server-launched runs (`vitest-runner`), auto-detected CI mode keeps `test:ci` a one-flag script, and default output paths (`crvy-rprtr.html`, `crvy-rprtr-*.json`, `screenshots/`) stay gitignored at the example root. Minimal config _is_ the message.

### 5. Baselines committed for darwin + linux

Generated once locally (`vitest run` → commit `-darwin`) and once in the CI container (`-linux`), mirroring the CT example. README documents the confirmed first-run UX (fails once while writing the reference, green from the second run) so the initial failure is expected, not alarming.

### 6. CI wiring

- `lint-and-typecheck` job: add an install step for `examples/vitest-browser` beside the CT one.
- `playwright-tests` job: install example deps and run the suite inside the Playwright container — validates the committed `-linux` baselines _and_ exercises the offline artifact path (`CI=true` variant optional; the plain run already writes live reports to a nonexistent server → offline fallback, another behavior worth CI coverage).
- `publish.yml`: mirror the CT install step for consistency.
- Root `package.json`: `example:vitest` script (`cd examples/vitest-browser && bunx vitest run`), following the working `example:ct` pattern (the older `example` script's target directory no longer exists — not this change's problem, do not copy it).

### 7. README structure mirrors the CT example

How-it-works diagram (vitest → vite → real Chromium → reporter WS → server UI / offline fallback), quickstart, first-run UX, the approve loop (edit a color constant in `src/`, rerun, diff appears, Approve, rerun green), `test:ci` artifacts, `update-snapshots`, limitations (terminal-run workflow today, `-t`/docker caveats only after `vitest-runner`), FAQ.

## Risks / Trade-offs

- [Published-package pin lags `main`] → example only uses long-shipped reporter surface (offline artifacts, approvals); README notes version requirements (`@crvy/rprtr ≥ 0.3.x`).
- [Baselines drift with Chromium upgrades] → pinned `playwright@1.59.0` and the pinned CI container keep renderer versions aligned on both platforms; regenerate per the README when bumping.
- [Example suite adds CI minutes] → single browser, three tests, reuses the existing container job; cost is seconds.
- [Root lint/typecheck scope] → the example has its own tsconfig; root gates unchanged (CT example already establishes the exclusion pattern).

## Open Questions

_None._
