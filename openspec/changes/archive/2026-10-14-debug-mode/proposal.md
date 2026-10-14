# Proposal

## Why

When a UI-launched run fails before producing output — a container that dies instantly, a listing that times out, a sidecar that never becomes ready — the terminal shows symptoms without the inputs: no command vector, no environment decisions, no mount sources, no phase timings, and the container that carried the evidence is removed. "The same command works manually" can be neither verified nor refuted. `run-launch-diagnostics` records compact facts always on; this change adds an opt-in debug mode that records the full launch surface, captures output a pipeline would swallow, and preserves failed containers for inspection.

## What Changes

- **Activation**: `--debug` and `ServerOptions.debug`, or `CRVY_RPRTR_DEBUG`. The server gate reads only these, never Playwright's `DEBUG`; the reporter gate reads `CRVY_RPRTR_DEBUG` with `DEBUG` kept as the legacy alias. The server exports the variable into every spawned process — runs, listings, containers — so one switch covers the whole path.
- **Records**: the full command and arguments of every spawn; environment names, with values only from a fixed safe allowlist and no credential-shaped values; for containers, image, name, pinned platform, and each bind-mount source with existence at launch; preparation-phase timings; listing command, failure reason, and a capped stderr excerpt.
- **Capture**: debug runs spawn with piped output mirrored to the terminal with stream prefixes, so output a `webServer`-style pipe swallows becomes visible; a silent child is recorded as writing nothing.
- **Retention**: debug keeps failed containers (no `--rm`, labeled, stale ones removed before reuse) and records their `docker logs`/`docker inspect` commands. Independently of debug, the sidecar records its state and recent logs before its failure-path removal.
- **Redaction**: terminal-only records — never in artifacts or live WebSocket messages, never credentials or token-bearing URLs.

## Capabilities

### New Capabilities

- `debug-mode`: activation and propagation, the recorded launch surface, child output capture, failed-container retention, and the redaction contract. `run-output` already covers the runner's own streams unconditionally; `debug-mode` covers rprtr's own decision trail and evidence preservation, whose activation, content, and privacy rules differ, so it is a separate capability.

### Modified Capabilities

- `vitest-docker-browser`: the sidecar lifecycle gains failure-evidence preservation — a sidecar that fails to start or become ready records its inspect state and recent logs before removal, so `docker-unavailable` is diagnosable.

## Non-goals

- Live-UI diagnostics and artifact embedding.
- Log files, JSON-lines output, or remote collection; terminal only.
- Retention for non-debug runs (the sidecar evidence snapshot is the one unconditional addition).
- Orchestrating Playwright `DEBUG` namespaces.
- Changing run behavior, refusals, or results.

## Impact

- Code: `RunController` and `createRealSpawn` (vectors, capture), launchers and `BrowserSidecar` (retention, snapshots, mount/phase records), listing spawns, `debug-log.ts`, CLI and `ServerOptions`, env forwarding.
- Sequencing: follows `run-launch-diagnostics` and `playwright-docker-browser`; container specifics target the sidecar-backed architecture.
- Docs: `README.md`, `docs/offline-mode.md`, `docs/docker-manual-smoke-test.md`.
- Published surface: new CLI flag and `ServerOptions` field; no new exports, bins, or peer dependencies.
