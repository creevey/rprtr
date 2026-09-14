# @crvy/rprtr

Playwright reporter with a visual regression UI for comparing and approving screenshot test diffs.

> **Pronunciation:** `crvy` sounds like "creevey," not "curvy."

## Installation

```bash
npm install --save-dev @crvy/rprtr
```

> **Requires:** Playwright ≥1.40, plus **Node 22+ or Bun** for the live UI server/CLI. You can install the package with npm, pnpm, yarn, or Bun.

## Setup

Add the reporter to your `playwright.config.ts`:

```ts
import { defineConfig } from '@playwright/test'

export default defineConfig({
  reporter: [['@crvy/rprtr', { screenshotDir: './screenshots' }]],
})
```

## Viewing Results

Start the UI server to view and approve screenshot diffs:

```bash
npx crvy-rprtr
```

Other package-manager launchers work too: `pnpm dlx crvy-rprtr`, `yarn dlx crvy-rprtr`, and `bunx crvy-rprtr`.

Open http://localhost:3000 in your browser.

Every test run also writes a browser-openable static artifact:

- `./crvy-rprtr.html`

Open `crvy-rprtr.html` directly from CI artifacts or your filesystem to review results without starting a server. The static artifact is self-contained except for screenshot image files, and it is read-only; use the server-backed UI to approve screenshots.

To open downloaded CI artifacts with the full approval UI, point the CLI at the artifact directory:

```bash
npx crvy-rprtr ./artifacts
```

## Reporter Options

| Option                                   | Type     | Default                        | Description                                                                                            |
| ---------------------------------------- | -------- | ------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `serverUrl`                              | `string` | `"ws://localhost:3000"`        | WebSocket URL of the Crvy Rprtr server                                                                 |
| `screenshotDir`                          | `string` | `"./screenshots"`              | Directory for saving screenshot artifacts                                                              |
| `offlineReportPath`                      | `string` | `"./crvy-rprtr-{worker}.json"` | Path for offline report when server is unavailable                                                     |
| `reportHtmlPath`                         | `string` | `"./crvy-rprtr.html"`          | Path for the browser-openable static report HTML                                                       |
| `playwrightSnapshotDir`                  | `string` | `undefined`                    | Override the Playwright snapshot directory used for passed-baseline display lookup                     |
| `playwrightSnapshotPathTemplate`         | `string` | `undefined`                    | Mirror Playwright `snapshotPathTemplate` for passed-baseline display resolution                        |
| `playwrightToHaveScreenshotPathTemplate` | `string` | `undefined`                    | Mirror Playwright `expect.toHaveScreenshot.pathTemplate` for passed-baseline display; takes precedence |

## Server CLI Options

```bash
npx crvy-rprtr [artifact-dir] [options]
```

If `artifact-dir` is provided, the CLI treats it as the directory containing:

- `report.json`
- `screenshots/`
- `crvy-rprtr-*.json`

Explicit flags override the paths derived from `artifact-dir`.

| Option             | Short | Default         | Description                                                                                                                                                                                                                                                                          |
| ------------------ | ----- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--port`           | `-p`  | `3000`          | Server port                                                                                                                                                                                                                                                                          |
| `--screenshot-dir` | `-s`  | `./screenshots` | Screenshot directory path                                                                                                                                                                                                                                                            |
| `--report-path`    | `-r`  | `./report.json` | Report JSON file path or directory containing `report.json` and `crvy-rprtr-*.json` files                                                                                                                                                                                            |
| `--config`         | `-c`  | auto-detect     | Playwright config path used to enable the run buttons at startup (Playwright only — Vitest runs are enabled by the Vitest reporter's registration). When omitted, the server discovers `playwright.config.*` in the working directory. A registering reporter always overrides this. |

When the server can resolve a run configuration (via `--config`/auto-discovery for Playwright, or once a reporter registers), the sidebar shows Start/Stop and per-test run buttons that launch the registered runner without leaving the browser:

- **Playwright** runs spawn `playwright test --config <config>` through your package manager with the rprtr reporter injected. Per-test reruns select exactly via positional `file:line` filters (or `--test-list` on Playwright ≥ 1.56), and update runs pass `--update-snapshots`.
- **Vitest** runs spawn `vitest run --config <config>` — the project's own Vitest config carries the reporter, so nothing is injected. Per-test reruns filter by test file plus a `-t` pattern built from the test's full title path; `-t` matches test names as a substring, so selection is approximate and similarly named tests may run too. Update runs pass `--update`.

Docker mode applies to Playwright runs only: with `--run-mode docker`, Vitest run requests fail fast with a clear message instead of launching a container; with `auto`, Vitest runs launch locally with a one-line warning. Approval-routing resolver overrides are available through the programmatic server API, not additional CLI flags.

## How It Works

1. **During test runs:** The Playwright reporter sends test results to the server via WebSocket in real-time and records the same run for artifact export.
2. **After tests complete:** A static `crvy-rprtr.html` artifact is written for direct browser viewing, and offline report JSON is also written if the server was unavailable.
3. **In the browser:** The UI shows all screenshot tests with side-by-side, swap, slide, and blend diff views.
4. **Approving changes:** Start the UI server and click "Approve" or "Approve All" to accept a new screenshot as the baseline. Playwright approval uses the same exact Playwright-aware resolver as passed-baseline display, including default layouts, unnamed screenshots, duplicate names, and custom templates when the running server was started with matching resolver options. Those approval-routing options are read from the server startup path, not from reporter options. If the server starts without explicit resolver overrides, approval falls back to the server defaults instead. If Crvy Rprtr cannot determine exactly one target path, it leaves the image unresolved instead of guessing. Vitest-reported screenshots carry their baseline path from the reporter, so they approve without any resolver configuration — including first-run baselines, where approving accepts the newly created reference as-is.

## Component Testing

Crvy Rprtr works with [Playwright Component Testing](https://playwright.dev/docs/test-components) (the stories + gallery model, Playwright ≥ 1.62) out of the box — component tests are regular Playwright tests, so live reporting, baseline display, diffs, approval, and Docker mode all work unchanged. See the complete, annotated example in [examples/component-testing](./examples/component-testing).

## Vitest Browser Mode

Crvy Rprtr also reports [Vitest Browser Mode](https://vitest.dev/guide/browser/) `toMatchScreenshot()` results (Vitest ≥ 4 < 5). Install the reporter together with a browser provider:

```bash
npm i -D @crvy/rprtr vitest @vitest/browser-playwright
```

Wire the reporter into your Vitest config:

```ts
import { playwright } from '@vitest/browser-playwright'
import { defineConfig } from 'vitest/config'

import { CrvyRprtrVitestReporter } from '@crvy/rprtr/vitest'

export default defineConfig({
  test: {
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      instances: [{ browser: 'chromium' }],
    },
    reporters: [new CrvyRprtrVitestReporter()],
  },
})
```

With a server running (`npx crvy-rprtr`), failed comparisons stream live and the UI serves Vitest's own screenshot files (reference, actual, diff) without copying them. Without a server, the reporter writes the same portable `crvy-rprtr.html` plus `crvy-rprtr-*.json` artifacts as Playwright runs, with screenshots copied content-addressed into `screenshotDir`.

Leave the reporter's `serverUrl` unset for dev use: the server injects `CRVY_RPRTR_SERVER_URL` into UI-launched runs, so the spawned reporter connects back to the server that launched it automatically. An explicitly configured `serverUrl` wins over the injected env, which would point a UI-launched run away from its launching server.

The UI's Start/Stop and per-test run buttons launch Vitest too: full suites and update runs spawn `vitest run --config <your vitest config>` (the reporter registers its config file and project root), while per-test reruns select the test file plus a `-t` title-pattern approximation of the test's title path. See [Server CLI Options](#server-cli-options) for the provider details and the docker-mode behavior.

Approvals work from the same UI buttons: the reporter declares each screenshot's baseline path, so **Approve** and **Approve All** update Vitest's `__screenshots__` references without resolver configuration. First-run baselines (a newly created reference with no diff) are approvable too — approving accepts the reference as the baseline and marks the test approved.

### Vitest Reporter Options

| Option              | Type      | Default                        | Description                                                            |
| ------------------- | --------- | ------------------------------ | ---------------------------------------------------------------------- |
| `serverUrl`         | `string`  | `"ws://localhost:3000"`        | WebSocket URL of the Crvy Rprtr server                                 |
| `screenshotDir`     | `string`  | `"./screenshots"`              | Directory for saving screenshot artifacts in offline/CI runs           |
| `offlineReportPath` | `string`  | `"./crvy-rprtr-{worker}.json"` | Path for offline report when server is unavailable                     |
| `reportHtmlPath`    | `string`  | `"./crvy-rprtr.html"`          | Path for the browser-openable static report HTML                       |
| `ci`                | `boolean` | auto-detected                  | Force offline/CI mode (content-addressed copies, portable artifacts)   |
| `referenceDir`      | `string`  | `"__screenshots__"`            | Overrides Vitest's default reference directory for location resolution |
| `attachmentsDir`    | `string`  | `".vitest-attachments"`        | Overrides Vitest's default attachments directory for artifact lookup   |

### Supported Layouts and Limitations

- Default Vitest layouts are resolved automatically: references under `<test file dir>/__screenshots__/<test file>/` and actual/diff artifacts under `.vitest-attachments/<test file dir>/<test file>/`. Explicit `referenceDir`/`attachmentsDir` options override the defaults.
- Custom Vitest `resolveScreenshotPath`/`resolveDiffPath` resolvers are not supported.
- First-run baselines surface as `baseline-only` images and are viewable.
- Per-test run selection is approximate (`-t` title-pattern matching); Playwright keeps exact `file:line` selection.

## Offline Mode

When the server isn't running during tests, the reporter automatically falls back to offline mode:

- Test events are queued in memory
- On test completion, events are written to `crvy-rprtr-{index}.json`
- On test completion, a self-contained `crvy-rprtr.html` is written for direct browser review
- When the server starts, it loads and merges all `crvy-rprtr-*.json` files from the offline report directory

## Passed Screenshot Modes

Crvy Rprtr keeps passed Playwright screenshot assertions visible in two fallback modes when Playwright does not emit a full passing comparison payload:

- `baseline-only`: Crvy Rprtr resolved the exact expected snapshot path and copied that baseline into the screenshot directory, so the UI can show the stored baseline.
- `declared-only`: the screenshot assertion was detected, but Crvy Rprtr could not resolve one exact snapshot file and therefore keeps the honest text-only fallback.

Exact resolution mirrors Playwright's screenshot naming and template rules for default layouts, unnamed screenshots, and explicitly configured custom templates. For slash-containing named screenshot titles, Crvy Rprtr may check both Playwright-equivalent variants and only uses a baseline when exactly one candidate wins.

Crvy Rprtr does not auto-read Playwright config for snapshot template discovery. If your suite uses a custom snapshot layout, pass the matching `playwrightSnapshotDir`, `playwrightSnapshotPathTemplate`, or `playwrightToHaveScreenshotPathTemplate` reporter options explicitly for passed-baseline display.

Approval routing uses the same resolver, but it reads its resolver settings from the server startup path today. The current user-facing place to pass those overrides is `startServer({...})`, via options such as `configDir`, `playwrightTestDir`, `playwrightSnapshotDir`, `playwrightSnapshotPathTemplate`, and `playwrightToHaveScreenshotPathTemplate`. The CLI does not expose flags for those overrides, so `npx crvy-rprtr` uses the server defaults when they are omitted. For slash-containing named screenshot titles, Crvy Rprtr only updates the baseline when one exact Playwright-equivalent target can be determined.

When the server is running, Crvy Rprtr also refreshes the UI after report JSON or screenshot artifacts change on disk.

## Cross-OS Artifact Loading

Crvy Rprtr stores image URLs exactly as the reporter that produced them saw them. In live mode (server running during the test run), failure artifacts are referenced by absolute path under `/file/<encoded>`; in CI/offline mode, attachments are copied into `screenshots/` and referenced by relative path under `/screenshots/`.

If you generate a report on one operating system and then open it on another (for example, downloading a Windows CI runner's `report.json` onto a macOS laptop), absolute-path `/file/...` URLs cannot resolve: the file is not on your filesystem. Crvy Rprtr logs a single diagnostic line per such request and returns 404. The `/screenshots/...` and `/baseline/...` URLs remain portable because they resolve through the server's `screenshotDir` or snapshot resolver.

For fully portable artifact loading across operating systems, run the reporter in CI mode (`ci: true`) and ship the `screenshots/` directory alongside the report JSON.

## Docker Mode

Run Playwright browsers inside a pinned Docker container so screenshot baselines are reproducible across machines — no local browser or system-dependency installation required.

```bash
npx crvy-rprtr --run-mode docker
```

The server still runs on your host; only `playwright test` executes in the container, against the official `mcr.microsoft.com/playwright:v<your @playwright/test version>-noble` image with your project bind-mounted. Reporters stream results back live, and approve/update flows work unchanged. Vitest runs are not containerized (their image would need vitest plus a browser provider): under explicit `--run-mode docker`, Vitest run requests fail fast; under `auto`, they launch locally with a warning.

| Mode             | Behavior                                                                        |
| ---------------- | ------------------------------------------------------------------------------- |
| `auto` (default) | Docker when a daemon is reachable, local on CI, warned local fallback otherwise |
| `docker`         | Always Docker; runs fail fast with `docker-unavailable` when the daemon is down |
| `local`          | Never Docker                                                                    |

| Option                         | Description                                                                                                                                                                  |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--run-mode <mode>`            | `local`, `docker`, or `auto` (default: `auto`)                                                                                                                               |
| `--docker-image <image>`       | Custom image. With a custom image, the container-side package manager is auto-detected from your lockfile (`npx` / `pnpm exec` / `yarn` / `bunx`); the image must contain it |
| `--docker-platform <platform>` | `linux/amd64` or `linux/arm64` (default: host architecture)                                                                                                                  |
| `--font-rendering <mode>`      | Text antialiasing for runs in either mode: `grayscale` (default, deterministic) or `inherit` (see [Text antialiasing](#text-antialiasing))                                   |

Programmatic equivalents: `startServer({ runMode: 'docker', fontRendering: 'grayscale', docker: { image, platform, command, extraArgs } })`. `docker.command` overrides the container-side invocation verbatim (e.g. `['pnpm', 'exec', 'playwright']`); `docker.extraArgs` appends raw `docker run` flags.

### Windows

The recommended Windows setup is **WSL2**: enable Docker Desktop's WSL2 integration (Settings → Resources → WSL integration), keep the project inside the WSL filesystem (e.g. `~/proj` in your distro, not `/mnt/c/...` — bind-mounts from `/mnt/c` are slow and lack inotify events), and run `npx crvy-rprtr` from the WSL shell. Paths and rendering then behave exactly as on Linux, so baselines match CI.

Running natively on a Windows host (PowerShell/cmd) works but is **experimental**: Docker Desktop translates the `C:\proj:/work` mount, and crvy-rprtr rewrites Windows paths in container arguments, but this path has no CI coverage — expect a one-time experimental warning on the first run. Local (`--run-mode local`) Windows runs can never match Linux CI baselines (DirectWrite vs fontconfig text rendering) — which is exactly the problem Docker mode solves, so prefer WSL2.

Known limitations on native Windows: UNC project roots (`\\server\share\...`) are unsupported; drive-letter casing is normalized (`C:` ≡ `c:`), but path body case is not; Windows-specific host env vars (`PATH`, `TEMP`, `APPDATA`, `ProgramFiles`, ...) are filtered out so the container keeps its own environment (user env vars like API keys are still forwarded); single-file bind mounts (used for `--test-list`) can be flaky on some Docker Desktop versions — if the container sees an empty or missing test list, that is why.

Notes:

> **Important — baselines are image-specific, not architecture-specific.** Text rendering follows the image's fontconfig: Ubuntu-based images (including the default `mcr.microsoft.com/playwright:*-noble`) render text with subpixel (LCD) antialiasing and slight hinting, while Debian-based images (e.g. `node:24` + `playwright install --with-deps`) render grayscale with full hinting — different pixels _and_ slightly different text widths. Generate and verify baselines in the **same image** everywhere (CI and local), and regenerate baselines once after switching image flavor. See [docs/docker-screenshot-determinism.md](docs/docker-screenshot-determinism.md) for the full investigation.

- Baselines are **not** architecture-specific for typical DOM/text pages: amd64 and arm64 variants of the same image render bit-identically in practice (verified: 100/103 tests byte-identical between an amd64 CI runner and Apple Silicon). Use the native architecture on every host — do **not** pin `--docker-platform` to force amd64 emulation on Apple Silicon (Rosetta/QEMU is slower and less stable, and buys nothing). Residual risk: canvas 2D / complex SVG / WebGL content can show tiny cross-arch anti-aliasing diffs; handle per-test with `maxDiffPixels`.
- If your `playwright.config.ts` uses `webServer`, that server now starts inside the container: it must bind `0.0.0.0`, and hosts it references must resolve inside the container.
- Timezone and locale are pinned (`TZ=UTC`, `LANG=C.UTF-8`, `LC_ALL=C.UTF-8`) so date/number rendering in screenshots is stable; override via `docker.extraArgs` if you need a different locale under test.
- Text antialiasing is pinned too: a fontconfig drop-in mounted at `/etc/fonts/conf.d/99-crvy-rprtr-grayscale.conf` switches Chromium to grayscale AA, so screenshots no longer depend on whether the image enables subpixel (LCD) rendering. Opt out with `fontRendering: 'inherit'` (see [Text antialiasing](#text-antialiasing)).
- The "Run & update baselines" button (▶↻) regenerates baselines inside the container, keeping generation and verification in the same image.

### Text antialiasing

Chromium on Linux takes its text AA mode from **fontconfig**, so screenshots change with the environment rather than with the page: a system Chromium passed via `executablePath`, an agent-provided binary or a second image renders the same text with colored subpixel fringes on every glyph. Glyph positions stay identical, so the diff is invisible by eye and fatal to the comparator — colored fringes on ~3% of a text-heavy page, channel deltas up to 100.

crvy-rprtr therefore pins grayscale AA in **both** run modes, with no configuration:

| run mode | mechanism                                                                                                                                                                                  |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| docker   | fontconfig drop-in mounted at `/etc/fonts/conf.d/99-crvy-rprtr-grayscale.conf`                                                                                                             |
| local    | `FONTCONFIG_FILE` exported to the spawned `playwright test` process (a generated root config that includes the system one, then forces `rgba=none`); every browser it launches inherits it |

Both were verified to produce byte-identical screenshots, so runs can be mixed freely. On macOS and Windows the local-mode override is skipped: fontconfig does not drive text rendering there (macOS has had no subpixel AA since Mojave, Windows uses DirectWrite).

Turn it off with `fontRendering: 'inherit'` — as `startServer({ fontRendering: 'inherit' })` or `crvy-rprtr --font-rendering inherit` — when faithful "what a desktop user sees" text matters more than determinism. `docker: { fontRendering: 'inherit' }` still works and takes precedence in docker mode.

#### Runs that crvy-rprtr does not launch

Plain `npx playwright test` in CI is not covered by the above — it does not go through the launcher. Match it from the Playwright config:

```ts
import { defineConfig } from '@playwright/test'
import { deterministicLaunchOptions } from '@crvy/rprtr/rendering'

export default defineConfig({
  use: { launchOptions: deterministicLaunchOptions() },
})
```

The helper writes the same generated fontconfig root config and merges `FONTCONFIG_FILE` into `launchOptions.env`, keeping the inherited environment and the caller's own entries. It applies to every browser (`deterministicLaunchOptions(base, { fontRendering: 'inherit' })` opts out), needs no file committed to the repo, and produces screenshots byte-identical to both run modes. Outside Linux it returns the options unchanged.

`deterministicChromiumLaunchOptions()`, which adds `--disable-lcd-text` instead, remains available for configs that cannot set browser env vars; it is byte-identical for Chromium but Chromium-only, since Firefox rejects unknown command-line flags.

Firefox and WebKit need no equivalent: the Playwright builds never rasterize with subpixel AA — forcing `rgba=rgb` through fontconfig leaves their screenshots byte-identical — so a multi-browser suite is fully covered.

Baselines captured with subpixel AA have to be regenerated once after adopting any of this. Full investigation: [docs/text-antialiasing-determinism.md](docs/text-antialiasing-determinism.md).

## Programmatic API

```ts
import { startServer } from '@crvy/rprtr/server'

// reportPath can be a directory (will use report.json inside)
await startServer({
  port: 3000,
  screenshotDir: './screenshots',
  reportPath: './artifacts',
})

// Or a specific file path
await startServer({
  port: 3000,
  screenshotDir: './screenshots',
  reportPath: './artifacts/report.json',
})
```

If you need approval routing to follow a custom Playwright snapshot layout, pass the resolver options when starting the server programmatically:

```ts
await startServer({
  port: 3000,
  screenshotDir: './screenshots',
  reportPath: './artifacts',
  configDir: process.cwd(),
  playwrightTestDir: './tests',
  playwrightSnapshotDir: './tests/__screenshots__',
  playwrightToHaveScreenshotPathTemplate: '{snapshotDir}/{testFilePath}/{arg}{ext}',
})
```

The programmatic server API works in both Node 22+ and Bun.

## Development

```bash
bun install
bun run dev      # Start dev server with HMR
bun run build    # Build for production
bun run test     # Run tests
bun run lint     # Lint with oxlint
```

## License

MIT
