# Vitest Browser Mode example — reported by @crvy/rprtr

This example shows [Vitest Browser Mode](https://vitest.dev/guide/browser/) working end to end with the `@crvy/rprtr` reporter: live reporting in the browser, screenshot baselines, visual diffs, and one-click approval.

It is intentionally **framework-free** (vanilla DOM components, no dependencies beyond Vitest, its browser provider, and the reporter) so every piece of the mechanism is visible — the same philosophy as the [component-testing example](../component-testing).

> **Version note:** the `CrvyRprtrVitestReporter` is published under the `@crvy/rprtr/vitest` export. npm release **0.3.3 predates it** — use the next release (`@crvy/rprtr@^0.3.3` in `package.json` resolves it as soon as it is published).

## Requirements

- `@crvy/rprtr` with Vitest support (see version note above)
- Vitest **4.1.x** with a matching `@vitest/browser-playwright` (both pinned to `4.1.11` here — version skew between Vitest and its browser provider is the most common breakage)
- Playwright **1.59.0** (the provider launches its browsers; matches the official Docker image tag used in CI)
- Node **≥ 22** or Bun

## How it works

```
┌─────────────────────────┐
│ vitest run              │
│  (your terminal)        │
└───────────┬─────────────┘
            │ vite compiles config + tests + components
            ▼
┌─────────────────────────┐
│ real Chromium instance  │   tests execute IN the browser:
│  (headless, no server   │   import components, render into the
│   of your own needed)   │   live document, toMatchScreenshot()
└───────────┬─────────────┘
            │ reporter events (WebSocket)
            ▼
┌─────────────────────────┐        approve: copy actual image
│ crvy-rprtr server       │───────────────────────────────▶ baseline .png
│  UI · diffs · runs      │        onto the __screenshots__ reference
└───────────┬─────────────┘
            │ no server running?
            ▼
┌─────────────────────────┐
│ offline fallback        │   crvy-rprtr.html (self-contained,
│ (automatic)             │   browser-openable) + crvy-rprtr-*.json
└─────────────────────────┘
```

Three concepts ([docs](https://vitest.dev/guide/browser/)):

- **Browser Mode** runs your test files inside a real browser. Vite compiles and serves the test and component modules, so tests import real component modules (`../src/button.js`) and render into the live document — no dev server, gallery, or mount contract of your own.
- **`toMatchScreenshot(name)`** screenshots a locator and compares it against a reference. Failure messages carry reference/actual/diff paths — exactly what the reporter surfaces as image attachments. For passing assertions Vitest records nothing, so the reporter extracts the declared names from the test source and shows the stored baseline instead.
- **`CrvyRprtrVitestReporter`** streams every test and screenshot comparison to the rprtr UI while the run is in flight. Each payload carries the baseline path, so **Approve** updates Vitest's own `__screenshots__` references without any resolver configuration.

## Project layout

```
├── vitest.config.ts        # browser mode + playwright provider + rprtr reporter
├── src/
│   ├── button.js           # factory → { root, update } (static, per-props rendering)
│   └── expandable.js       # stateful component (internal `expanded` state)
├── tests/
│   ├── button.test.ts      # DOM assertions + update(), element screenshot
│   ├── expandable.test.ts  # click interaction → assertions → screenshot
│   └── __screenshots__/    # committed baselines (darwin + linux)
└── package.json            # private, own lockfile, published @crvy/rprtr
```

## Quickstart

```bash
cd examples/vitest-browser
bun install                 # or: npm install

# Terminal 1 — start the review/approval UI
bun run reporter            # → http://localhost:3000

# Terminal 2 — run the tests (nothing else to start; Vite + Chromium are managed by Vitest)
bun run test
```

Baselines are committed for **darwin and linux**, so the suite is green immediately on macOS and in the official `mcr.microsoft.com/playwright:v1.59.0-noble` image. On those platforms the quickstart run **passes** — and the sidebar still lists the two visual tests with their committed baselines as previews.

## First run on a new platform

`toMatchScreenshot()` behaves like Playwright's `toHaveScreenshot()`: on a platform without committed baselines (say you add a `-webkit` browser instance), the first run **creates the reference and fails the test** — this is normal and the failure message says so. The second run is green. Review the created image, then commit it. This first-run UX is unchanged by passing-test visibility: until a reference exists, there is nothing to preview, so the test only appears once the reference is on disk (as a failure on first run, or as a baseline preview afterwards).

## The rprtr loop, step by step

1. **Live view** — keep the UI open while tests run; each test appears with status and duration, and screenshot comparisons show inline. **Passing visual tests stay visible after the run ends**: the reporter reads each test's `toMatchScreenshot()` declarations from the test source and shows the committed baseline as a preview (`baseline-only`), so the green run still lists `matches the button baseline` and `expands on click and matches the expanded baseline` with their baselines — and both stay approvable (approving a passing baseline is a same-file no-op that marks the test approved).
2. **Make a visual change** — e.g. change the accent color in `src/button.js`:
   ```js
   export const ACCENT_COLOR = '#2563eb' // → try '#dc2626'
   ```
   ```bash
   bun run test   # → 'matches the button baseline' fails
   ```
   The failing test now shows **expected / actual / diff** images with side-by-side, swap, slide, and blend views.
3. **Approve** — click **Approve** on the diff (or **Approve All**). rprtr copies the actual image onto the exact reference Vitest will compare against next run:
   ```
   tests/__screenshots__/button.test.ts/button-solid-chromium-darwin.png
   ```
   Re-run: green.
4. **Regenerate on purpose** — `bun run update-snapshots` (runs `vitest run --update`).
5. **CI artifacts** — `bun run test:ci` runs with `CI=true`: the reporter switches to offline mode and writes `crvy-rprtr-*.json` and the self-contained `crvy-rprtr.html` for review without a server. When a comparison produced artifacts (e.g. a failure), the images are copied content-addressed into portable `screenshots/`. Passing runs get the same treatment: the baseline is copied content-addressed and the static/offline report shows the visual test as a `baseline-only` image.

## Run buttons

With the UI server running, the sidebar's Start/Stop and per-test ▶ buttons launch Vitest too: the reporter registers its config file and project root, and the server spawns `vitest run --config vitest.config.ts` with results streaming back into the UI. Per-test reruns select the test file plus a `-t` title-pattern approximation. See the [main README](../../../README.md#vitest-browser-mode) for details.

The buttons are enabled as soon as the server starts — it discovers this example's `vitest.config.ts` and lists the tests (`bun run reporter` → the sidebar shows `button.test.ts` and `expandable.test.ts` entries as pending before anything has run). A real run replaces that list with actual results.

## Where baselines live

Vitest's default layout places references next to the test file:

```
tests/__screenshots__/<test file>/<name>-<browser>-<platform>.png
                        │           │        │         └─ darwin / linux / …
                        │           │        └─ browser (chromium)
                        │           └─ the name passed to toMatchScreenshot()
                        └─ the test file's name
```

Actual/diff artifacts land in `.vitest-attachments/` (gitignored); the reporter's offline output (`screenshots/`, `crvy-rprtr-*.json`, `crvy-rprtr.html`) is gitignored too.

## Docker mode (sidecar browsers)

With `--run-mode docker` (or auto mode with a reachable daemon), the server routes this example's runs through a **managed `playwright run-server` sidecar**: it pulls `mcr.microsoft.com/playwright:v<playwright-version>-noble`, starts a warm container with the same grayscale fontconfig/locale pinning as Playwright docker mode, and exports the container's loopback endpoint through `CRVY_RPRTR_BROWSER_WS`. Vitest itself still runs on the host — only the browser moves into the image — so the config above is all the cooperation needed, and the same snippet works in CI against a sidecar you manage yourself (set `CRVY_RPRTR_BROWSER_WS` before `vitest run`).

Explicit docker mode without the snippet in the project's Vitest config fails fast with `docker-missing-browser-hook`; auto mode warns once and runs locally. See [docker screenshot determinism](../../../docs/docker-screenshot-determinism.md) for the full contract.

## Limitations

- **Terminal workflow** — this example runs Vitest from your terminal (or the UI run buttons); docker mode is exercised through the UI server, which manages the sidecar.
- **Per-test rerun selection is approximate** (`-t` matches the title path as a substring); Playwright keeps exact `file:line` selection.
- **New product features reach this example only after the next npm publish** — it depends on the published `@crvy/rprtr` package (see version note).

## FAQ

- **`Error: listen EADDRINUSE` / the UI never receives events** — port 3000 is taken. Start the server elsewhere (`bunx crvy-rprtr -p 3100`) and point the reporter at it with `CRVY_RPRTR_SERVER_URL=ws://localhost:3100 bun run test`.
- **The sidebar lists tests before the first run** — that's startup discovery: the server asks Vitest to enumerate the suite when it starts (collection only, no browser launch). The list is pending-only; run the tests to get real results, and edits made after the server started appear on the next run.
- **Visual tests fail on a brand-new machine/CI runner** — you're on a platform suffix without baselines (e.g. first linux run without `-linux` references). Run once to write them, or `bun run update-snapshots`, then commit.
- **Diffs appear everywhere after an intentional redesign** — use `bun run update-snapshots`, or click **Approve All** in the UI, then commit the regenerated `__screenshots__/` files.
- **The config fails to load with `Missing "./vitest" specifier`** — your `@crvy/rprtr` version predates the Vitest reporter (see version note at the top).
- **Chromium doesn't start** — the playwright provider launches the pinned `playwright@1.59.0` browsers; run `bunx playwright install chromium` once if they are missing.
