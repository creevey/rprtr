# Offline Mode

When the Crvy Rprtr server is unavailable (e.g., CI matrix builds), both reporters — the Playwright reporter and the Vitest Browser Mode reporter — operate in offline mode to generate local report files for later review.

## How It Works

1. Reporter attempts WebSocket connection to server (or goes straight offline when `CI` is detected)
2. If connection fails, reporter enters **offline mode**
3. Events are queued locally during test execution
4. At the end of the run, reporter writes one `crvy-rprtr-0.json` for the whole run
5. At the end of the run, reporter also writes `crvy-rprtr.html` for direct browser viewing

## Server-Side Loading

When the Crvy Rprtr server starts, it automatically scans the offline report directory for reports named `crvy-rprtr.json` or `crvy-rprtr-<digits>.json` and merges them into the active `reportData`.

## CI Integration

```typescript
// playwright.config.ts
reporter: [
  [
    './src/reporter.ts',
    {
      serverUrl: process.env.CRVY_RPRTR_SERVER_URL ?? 'ws://localhost:3000',
    },
  ],
]
```

```typescript
// vitest.config.ts
reporters: [
  new CrvyRprtrVitestReporter({
    serverUrl: process.env.CRVY_RPRTR_SERVER_URL ?? 'ws://localhost:3000',
  }),
],
```

## Artifacts

Upload these files as CI artifacts:

- `crvy-rprtr.html` - browser-openable static report
- `screenshots/` - all screenshots
- `crvy-rprtr-0.json` - event data for the run

To reopen those artifacts with the full approval UI:

```bash
npx crvy-rprtr \
  --report-path ./artifacts \
  --screenshot-dir ./artifacts/screenshots
```

Or with explicit file path:

```bash
npx crvy-rprtr \
  --report-path ./artifacts/report.json \
  --screenshot-dir ./artifacts/screenshots
```

`pnpm dlx`, `yarn dlx`, and `bunx` can run the same command as well.

## Limitations

- Offline events are only written to file at the end of the run (`onEnd()` for Playwright)
- If WebSocket reconnects after being offline, queued events stay in memory and are NOT sent to the server
- One offline report is written per run, regardless of how many workers execute tests
- The static `crvy-rprtr.html` artifact is read-only and does not apply approvals by itself

## Environment Variables

| Variable                | Description                                                                                                        | Default               |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------ | --------------------- |
| `TEST_WORKER_INDEX`     | Legacy worker-index fallback for offline metadata; it does not change the default report file name                 | `0`                   |
| `CRVY_RPRTR_SERVER_URL` | WebSocket server URL                                                                                               | `ws://localhost:3000` |
| `CRVY_RPRTR_DEBUG`      | Emit the reporter's debug log lines to the terminal (any non-empty value; `DEBUG` still works as the legacy alias) | unset                 |
