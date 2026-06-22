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

| Option             | Short | Default         | Description                                                                               |
| ------------------ | ----- | --------------- | ----------------------------------------------------------------------------------------- |
| `--port`           | `-p`  | `3000`          | Server port                                                                               |
| `--screenshot-dir` | `-s`  | `./screenshots` | Screenshot directory path                                                                 |
| `--report-path`    | `-r`  | `./report.json` | Report JSON file path or directory containing `report.json` and `crvy-rprtr-*.json` files |
| `--config`         | `-c`  | auto-detect     | Playwright config path used to enable the run buttons at startup. When omitted, the server discovers `playwright.config.*` in the working directory. A registering reporter always overrides this. |

When the server can resolve a Playwright config (via `--config` or auto-discovery, or once a reporter registers), the sidebar shows Start/Stop and per-test run buttons that trigger `playwright test` without leaving the browser. Approval-routing resolver overrides are available through the programmatic server API, not additional CLI flags.

## How It Works

1. **During test runs:** The Playwright reporter sends test results to the server via WebSocket in real-time and records the same run for artifact export.
2. **After tests complete:** A static `crvy-rprtr.html` artifact is written for direct browser viewing, and offline report JSON is also written if the server was unavailable.
3. **In the browser:** The UI shows all screenshot tests with side-by-side, swap, slide, and blend diff views.
4. **Approving changes:** Start the UI server and click "Approve" or "Approve All" to accept a new screenshot as the baseline. Approval uses the same exact Playwright-aware resolver as passed-baseline display, including default layouts, unnamed screenshots, duplicate names, and custom templates when the running server was started with matching resolver options. Those approval-routing options are read from the server startup path, not from reporter options. If the server starts without explicit resolver overrides, approval falls back to the server defaults instead. If Crvy Rprtr cannot determine exactly one target path, it leaves the image unresolved instead of guessing.

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
