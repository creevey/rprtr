# Tasks

## 1. Platform-aware gateway probe

- [x] 1.1 Add failing matrix cases to `tests/docker-preflight.test.ts`: with an injected `platform: 'linux'` and injected `hostAddresses`, a gateway address answering only at the loopback alias produces the new loopback-only notice, and one answering at a non-loopback IPv4 address produces no notice; with `platform: 'darwin'` or `'win32'` the loopback alias keeps counting as reachable; nothing answering keeps the existing gateway notice. Verify: `bun run build && cd tests && bun test docker-preflight.test.ts` fails on the new assertions.
- [x] 1.2 Implement the platform-aware availability and the loopback-only notice in `src/server/docker-host-services.ts`, defaulting `hostAddresses` to the host's non-internal IPv4 addresses from `os.networkInterfaces()`. Verify: `bun run build && cd tests && bun test docker-preflight.test.ts` passes and `bun run typecheck` is clean.
- [ ] 1.3 Add a failing launcher case to `tests/docker-launcher.test.ts` that the per-run diagnostic receives the launcher's platform seam, then pass `platform` through in `src/server/docker-launcher.ts`. Verify: `bun run build && cd tests && bun test docker-launcher.test.ts` passes.

## 2. Reporter output passthrough

- [x] 2.1 Add failing cases in a new `tests/reporter-output.test.ts`: `onError` writes the message and stack to the injected stderr seam, `onStdOut`/`onStdErr` write chunks verbatim to the matching seams, both hold with `ci: true` and with no live transport, and the emitted report messages are unchanged. Verify: `bun run build && cd tests && bun test reporter-output.test.ts` fails.
- [x] 2.2 Implement `onError`/`onStdOut`/`onStdErr` in `src/reporter.ts`, extend `ReporterSeams` with `stdout`/`stderr` write seams defaulting to the process streams, and add the error formatter next to the display helpers in `src/reporter-utils.ts`. Verify: `bun run build && cd tests && bun test reporter-output.test.ts` passes and `bun run typecheck` is clean.
- [x] 2.3 Add a regression case that forwarded output leaves persisted report state and offline artifacts unchanged, then run it alongside the existing artifact suites. Verify: `bun run build && cd tests && bun test reporter-output.test.ts offline-artifact.test.ts` passes.

## 3. Docs

- [x] 3.1 Update `docs/docker-host-services.md`: platform matrix (Linux loopback-only answers warn; Docker Desktop forwards host loopback), probe semantics (gateway hostname, then non-loopback IPv4 addresses, then the loopback alias only on Docker Desktop), and the loopback-only bind remedy. Verify: `bun run format:check`.

## 4. Full verification

- [ ] 4.1 Run the complete gate and the browser suite: `bun run check` and `bun run test:playwright`; confirm every task above is checked and the docs page is updated. Fix any surfaced issues before declaring the change complete.
