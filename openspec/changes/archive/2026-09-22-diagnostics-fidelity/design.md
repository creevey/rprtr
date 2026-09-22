# Design

## Context

See `proposal.md - Why` for motivation and `specs/` for the required behavior.

Current state this design builds on:

- `src/server/docker-host-services.ts` owns the divergence diagnostic: injectable `HostServiceProbe` seams (`http`, `tcp`), address parsing/dedup, and `isAddressAvailable`, which probes the gateway hostname and then falls back to the loopback alias. It has no platform or network-interface knowledge today.
- `src/server/docker-launcher.ts` already carries an injectable `platform` seam (`DockerLauncherOptions.platform`, default `process.platform`) for the win32 experimental warning; `diagnose()` currently passes only `{ config, probe }`.
- `docs/docker-host-services.md` documents the platform matrix and the "probes gateway addresses twice" behavior; the page is part of the contract and changes with the probe.
- `src/reporter.ts` (`CrvyRprtr`) implements only `onBegin`/`onTestBegin`/`onTestEnd`/`onEnd`. Playwright's internal reporter forwards `onError`/`onStdOut`/`onStdErr` when implemented and drops them otherwise; the `webServer` plugin routes its process output through the stdout/stderr hooks. The reporter does not implement `printsToStdio`, so Playwright's default list/line fallback is not injected — passthrough must print itself.
- `ReporterSeams` (constructor injection shared with font rendering) is the established seam for reporter-side side effects (`log`, `warn`).
- A sibling fix already applied in the working tree makes the docker preflight listing strip `CI`; it is out of scope here and does not interact with either decision below.

## Goals / Non-Goals

**Goals:**

- Judge a gateway address by what the container can actually reach on the host platform, and turn the Linux loopback-only case into a warning that names the remedy.
- Restore terminal diagnosis of pre-test failures when crvy-rprtr is the only reporter, without changing report state, the UI, or artifacts.

**Non-Goals:**

- No container-side probing, no Docker network inspection, and no new `DockerExec` dependency in the diagnostic.
- No changes to the loopback `webServer`/`baseURL` rules; only the gateway-address rule changes.
- No live-UI error event; the terminal is the delivery surface.
- No new runtime dependency.

## Decisions

### 1. Platform seam: Docker Desktop vs Linux, injected from the launcher

`diagnoseDockerHostServices` gains a `platform: NodeJS.Platform` input (default `process.platform`); `createDockerLauncher` passes its existing `platform` seam through. `darwin` and `win32` are Docker Desktop hosts; everything else — Linux and WSL2 — uses the Linux rule.

- Alternative: detect the Docker daemon flavor (Desktop vs Engine). Rejected: no reliable host-side signal, and the documented platform matrix already maps by host OS.
- Consequence: Docker Desktop for Linux is treated as Linux and may warn for a loopback-only service it could reach. It over-warns instead of silently passing; the notice names the remedy.

### 2. Gateway availability: hostname, then non-loopback IPv4, then loopback only on Docker Desktop

`isAddressAvailable` for a gateway address probes, in order: the gateway hostname; each non-loopback IPv4 address of the host; the loopback alias only when the platform is Docker Desktop. A non-loopback answer counts as reachable on every platform, because the gateway routes to host interfaces; the loopback alias is the only platform-dependent one.

- Alternative: on Linux simply drop the loopback fallback. Rejected: a `0.0.0.0`-bound service answers at loopback on the host and is reachable from the container, so dropping it without non-loopback probing would false-positive.
- Alternative: resolve the Docker bridge gateway IP via `docker network inspect` and probe that address. Rejected: adds a Docker dependency and latency to a per-run diagnostic, and custom networks / `docker.extraArgs` make it fragile.
- Bounded like the existing probe: interfaces are few, probes share the concurrency limit and the short timeout, and addresses are deduplicated.

### 3. Two Linux gateway notices instead of one

When no reachable answer exists, the diagnostic distinguishes: loopback answers but nothing reachable (Linux) → a loopback-only notice naming the bind remedy (`0.0.0.0` or a non-loopback interface); nothing answers → the existing "no host service answers" notice. Both keep the docs link.

- Alternative: one merged notice. Rejected: the remedies differ — bind the service versus start it.

### 4. Interface seam for tests

Add `hostAddresses?: () => readonly string[]` next to the existing `probe` seam, defaulting to the host's non-internal IPv4 addresses from `os.networkInterfaces()`. The platform matrix then runs deterministically in tests without real interfaces or a real platform.

### 5. Reporter passthrough: implement the three hooks, keep `printsToStdio` default

`CrvyRprtr` gains `onError(error)`, `onStdOut(chunk)`, and `onStdErr(chunk)`. `onStdOut`/`onStdErr` write chunks verbatim to the matching stream; `onError` writes a formatted message (error message plus stack when present) to stderr. Formatting is a small helper next to the existing display helpers in `src/reporter-utils.ts` — no new module, and no import of Playwright's internal `formatError`. `ReporterSeams` gains `stdout`/`stderr` write functions (defaults `process.stdout.write`/`process.stderr.write`) so tests capture output without touching globals.

- Alternative: implement `printsToStdio(): false` and let Playwright inject the default list/line reporter. Rejected: the server spawns runs with inherited stdio and the UI already streams progress; a full default reporter duplicates progress and changes the terminal shape.
- Alternative: capture the spawned child's stderr in the server instead of the reporter. Rejected: Playwright consumes and forwards the runner's output to reporters, so the child's stderr alone does not carry fatal error reports.

## Risks / Trade-offs

- [A LAN-only-bound service answers on a non-loopback address but `host.docker.internal` maps to the bridge IP on Linux] → The documented remedy already accepts "a non-loopback interface"; the notice names the gateway hostname so the user can verify. Documented in `docs/docker-host-services.md`.
- [Docker Desktop for Linux is misclassified] → Over-warns rather than silently passing; the platform rule and remedy are documented.
- [More probes per gateway address] → Bounded by the existing concurrency limit and short timeout.
- [Test-attached output becomes visible and can be noisy] → Matches Playwright's default reporter, which users expect when crvy-rprtr is the only reporter; the live UI is unchanged.
- [Fatal error formatting differs from Playwright's] → Message plus stack carries the actionable content; formatting parity is not required.

## Migration Plan

Additive; no config or artifact migration. Rollback reverts the probe rule and the reporter hooks. The docs update ships with the code.

## Published Surface

No exports-map, bin, peer-dependency, or `dist/` layout changes: the new reporter hooks are Playwright reporter methods, and the new seams are constructor/test injection points.
