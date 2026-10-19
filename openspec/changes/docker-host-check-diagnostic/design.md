# Design

## Context

See `proposal.md` — Why. The pieces that shape the approach:

- `src/server/docker-host-services.ts` owns the preflight diagnostic: `collectCandidates` deduplicates `webServer`/`baseURL` addresses, `resolveAvailability` judges what the container can reach, and `diagnoseCandidate` turns the result into one notice per address. The module is bounded by `p-limit` and a short probe timeout, never throws, and returns `string[]`.
- `HostServiceProbe` is an injectable seam (`http`, `tcp`) resolved by `resolveProbe`; the default `http` uses `fetch` with `redirect: 'manual'` and `AbortSignal.timeout`. Tests inject partial probes, so a new method must be optional or supplied by the default.
- The existing gateway rule already distinguishes reachability by host platform and probes the gateway hostname, the host's non-loopback IPv4 addresses, and the loopback alias. The host-header case sits inside the `reachable` branch of the gateway path.
- `docker-launcher.ts` passes `probeHostService` through unchanged; `run-preparation.ts` collects notices after `prepare()` and `RunController` broadcasts them with `run-status` and writes them through the `warn` sink.
- `fetch` (undici) silently drops a caller-supplied `Host` header, so the differential request needs `node:http`/`node:https`. The module already imports `node:net` for TCP probes.

## Goals / Non-Goals

**Goals:**

- One additional notice for the "reachable but rejects the hostname" case, produced by the existing per-address diagnostic and delivered through the existing channel.
- A probe seam that stays injectable and testable without real servers, and a default that sends a real `Host` header.
- Bounded, non-blocking behavior: one extra request per reachable gateway address, under the same timeout and concurrency limits.

**Non-Goals:**

- New notice categories (auth failures, ACLs, both-names-refused).
- Any refusal or blocking behavior; any new transport, persistence, or UI component.
- Detecting the refusal from inside the container or at reporter level.
- Changes to the non-gateway address paths.

## Decisions

### D1 — Judge the refusal by differential host-header requests

A `403` alone does not prove a host check: it can be auth, a WAF, or an ACL. The distinguishing signal is the same URL answering `403` for `Host: host.docker.internal:<port>` and a non-403 status for `Host: localhost:<port>` — exactly what Storybook's core server (and Vite's preview layer) do, since both allow loopback names by default and reject unknown hostnames. The check therefore requests the address twice with explicit headers and only warns on the divergent pair. Alternatives considered: treating any `403` as a host check (false positives on auth), reading the response body for `Invalid host` (coupled to third-party copy and to the HTML/plain-text distinction), and probing only the gateway name (cannot separate a host check from a blanket refusal).

### D2 — Extend `HostServiceProbe` with an explicit-host request

`HostServiceProbe` gains `hostHeader: (url: string, host: string) => Promise<number | null>`, and the default implementation issues an HTTP(S) request through `node:http`/`node:https` with the supplied `Host` value, a whole-request timeout (DNS and connect included), and no redirect following (a redirect is not a host check and should not be read as one). `resolveProbe` fills it like the other two methods, so existing partial probes in tests keep compiling and can inject just this method. The probe seam and its defaults move to `src/server/host-service-probe.ts` because `docker-host-services.ts` is at the repository's 300-line limit; the diagnostic keeps the policy. Alternatives: a separate module-level function (bypasses the injected seams and the timeout config), passing a headers bag to the existing `http` probe (changes every call site and the meaning of the seam), or shelling out to `curl` (new runtime dependency, host-platform variance).

The header value SHALL be the bare authority (`host.docker.internal:<port>`) for the gateway request and the loopback name for the control request; ports are taken from the parsed address, so a URL carrying userinfo or a token never reaches the request.

### D3 — The check lives in the gateway branch of `diagnoseCandidate`

The host-header check runs only when the address is the gateway and `resolveAvailability` returned `reachable`. That keeps the existing platform rules intact: an unreachable gateway address keeps its "nothing answers" notice, a loopback-only answer on Linux keeps its bind notice, and loopback `webServer`/`baseURL` addresses never enter the check. The differential request targets the host the service actually answered on — for a gateway address that is the gateway hostname, the host's non-loopback address, or the loopback alias — because the `Host` header, not the connection target, is what the service validates. Alternatives: checking every candidate (loopback addresses already produce their own notices and the container never sends them a gateway `Host` header), and checking before reachability (would probe services that are not there).

### D4 — One notice, task-first wording, no credentials

The notice names the address, states that the container reaches the service but the service rejects the hostname, and names both remedies — allow the gateway hostname (`core.allowedHosts` for Storybook, `server.allowedHosts` for Vite) or bind to all interfaces — with the docs pointer used by the other notices. It reuses the existing sanitized `origin`, so userinfo, query, and hash never appear. The wording avoids claiming which framework rejected the request: rprtr sees a status code, not the server's identity. Alternatives: framework-specific notices (requires sniffing headers or bodies) and a single generic message (drops the actionable fix that motivated the change).

### D5 — Non-blocking and ephemeral, like the rest of the diagnostic

The notice is returned with the other notices, so it rides `run-status` to the live UI, reaches the server console through the existing warning sink, and is not persisted anywhere. No new failure reason, no change to `prepareRun`'s result shape, no artifact change.

## Risks / Trade-offs

- **Extra request per reachable gateway address** → bounded by the existing `p-limit` slot and the short timeout; the control request is skipped unless the gateway request returned `403`, so the common case costs one request only when something is already suspicious.
- **A service that answers `403` to unknown names and to loopback for an unrelated reason** → the differential pair suppresses the warning; the worst case is a missed notice, never a false one.
- **A dev server that rejects `localhost` but allows the gateway name** → no warning (control request non-403), which is correct: the container is not refused.
- **`403` from an auth proxy in front of an otherwise working service** → the loopback control request is also refused, so no warning.
- **The planned sidecar migration deletes this diagnostic** → the change is scoped to the in-container line and its docs; `playwright-docker-browser` supersedes it wholesale.

## Migration Plan

Additive and warn-only: no configuration, data, or API migration. Rollback is a code revert. Documentation updates ride the same commit as the code.

## Open Questions

None.
