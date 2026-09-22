# Docker Host Services: Reaching Host Dev Servers from Docker Mode

Docker run mode executes `playwright test` inside the Playwright image. Every address the run
touches — a Storybook dev server declared by `webServer`, an API stub reached through
`baseURL` — must be reachable from the **container's** network namespace. URLs written for
the host (`http://localhost:6006`) are not: inside the container, `localhost` is the
container itself.

## The trap: `webServer` fails silently

Playwright's `webServer` plugin logs nothing at normal verbosity. It either

- **reuses** an already-answering URL (when `reuseExistingServer` is true and something
  answers), or
- **starts `command`** in the current namespace.

Only `DEBUG=pw:webserver` distinguishes the two. Docker mode makes this sharper: `CI` is
stripped from the container environment, so the common `reuseExistingServer: !process.env.CI`
evaluates to `true` inside the container, and Playwright tries to reuse a host service that
the container cannot see — then starts its own copy of the command in-container, from
host-installed dependencies that usually are not there. The run either fails on the command
or passes against a container-local server, quietly diverging from the host.

## The contract: two environment variables

A docker-mode run exports exactly two extra variables into the **container**:

| Variable                  | Value                  | Set for        |
| ------------------------- | ---------------------- | -------------- |
| `CRVY_RPRTR_DOCKER`       | `1`                    | container only |
| `CRVY_RPRTR_HOST_GATEWAY` | `host.docker.internal` | container only |

They sit next to the existing `CRVY_RPRTR_SERVER_URL` / `CRVY_RPRTR_PORTABLE_ARTIFACTS` /
rendering pins, and rely on the `--add-host host.docker.internal:host-gateway` mapping the
run already adds. Local runs and Vitest runs — including sidecar-backed Vitest runs, whose
test process stays on the host — never see either variable, and a same-named variable on the
host cannot shadow the values rprtr sets.

## Recipe: address the host from the config

Derive the URLs from `CRVY_RPRTR_HOST_GATEWAY`, falling back to `localhost` so local and CI
runs stay unchanged:

```ts
// playwright.config.ts
import { defineConfig } from '@playwright/test'

const host = process.env.CRVY_RPRTR_HOST_GATEWAY ?? 'localhost'

export default defineConfig({
  webServer: {
    command: 'npm run storybook',
    url: `http://${host}:6006`,
    reuseExistingServer: !process.env.CI,
  },
  use: {
    baseURL: `http://${host}:6006`,
  },
})
```

The array form works the same way:

```ts
webServer: [
  { command: 'npm run storybook', url: `http://${host}:6006`, reuseExistingServer: !process.env.CI },
  { command: 'npm run api', url: `http://${host}:4000`, reuseExistingServer: !process.env.CI },
],
```

Inside the container the run reuses the host services through `host.docker.internal`; outside
it, nothing changes. rprtr never rewrites `webServer` or `baseURL` for you — the contract is
opt-in in the project config.

## What rprtr warns about

Before a docker-mode run starts, rprtr resolves the project config through Playwright's own
listing — with the contract exported, so the recipe above resolves the way it will inside the
container — and probes the host side of every distinct `webServer` / `baseURL` address. It
warns, without blocking the run, when the container will diverge from the host:

| Case                                                                                      | What it means                                                                                                                                                                     |
| ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Loopback `webServer` with `reuseExistingServer` intent, and a service answers on the host | Playwright will not reuse the host service; it runs `command` inside the container. Add the recipe above.                                                                         |
| Loopback `baseURL` not served by a `webServer` entry, and a service answers on the host   | Tests address the container's own loopback instead of the host service. Add the recipe above.                                                                                     |
| Gateway address where nothing answers on the host                                         | That address can only be served from the host, so the run will fail or time out. Start the service (or fix `webServer`).                                                          |
| Gateway address answering only on the host's loopback, on Linux                           | A Linux container cannot reach host loopback through `host.docker.internal`. Bind the service to `0.0.0.0` (or a non-loopback interface) and allow the port through the firewall. |

Warnings appear in the live UI sidebar for the run and in the server console. They are never
written into `report.json` or the static HTML artifact. Places with no warning are places with
no divergence: a loopback address where nothing answers, a gateway address the container can
reach on its host platform (see the matrix below), and hosts that are neither loopback nor the
gateway.

The config summary is cached per server process, like the browser pins: after editing
`webServer` or `baseURL`, restart the server to re-read it. Host services are probed fresh on
every run request, so starting or stopping a dev server is picked up without a restart.

## Platform matrix

Reaching a **loopback-only** host service (`127.0.0.1:<port>`) from a container depends on the
host platform:

| Host                             | Loopback-only host services reachable? | Notes                                                                                                                                                                                                |
| -------------------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS / Windows (Docker Desktop) | Yes, via `host.docker.internal`        | Docker Desktop forwards the host's loopback. Verified 2026-09-22 with a `127.0.0.1`-bound server and `node:22`; a gateway address answering only here is not warned about.                           |
| Linux (Docker Engine)            | No                                     | Bind the service to `0.0.0.0` (or a non-loopback interface) so the host gateway can reach it, and allow the port through the firewall. A gateway address answering only on loopback is warned about. |
| WSL2                             | Follows the Linux rule                 | Native Windows hosts are experimental in docker mode; run from WSL2 with the project in the WSL filesystem.                                                                                          |

A gateway address is judged by what the container can reach on its host platform: rprtr probes
the gateway hostname (`host.docker.internal`), then the host's non-loopback IPv4 addresses, and
finally the loopback alias of the same port. A non-loopback answer counts everywhere; a loopback
answer counts only on Docker Desktop hosts, because Docker Desktop forwards host loopback into
containers and Linux does not.

## Probe semantics

The preflight mirrors Playwright's own readiness check:

- an HTTP response **below 404** counts as available (2xx and 3xx);
- a `404` at `/` is retried at `/index.html` — dev servers that only serve a built
  `index.html` count as available;
- `port`-only `webServer` entries use a TCP connect, like Playwright's port waiter;
- a gateway address is probed at the gateway hostname, then at the host's non-loopback IPv4
  addresses, then at the loopback alias — the loopback answer counts as reachable only on
  Docker Desktop hosts;
- probes use a short timeout, and any network failure counts as "no service".

## Related

- [docker-manual-smoke-test.md](./docker-manual-smoke-test.md) — end-to-end docker smoke
  scenarios, including the troubleshooting table.
- [docker-screenshot-determinism.md](./docker-screenshot-determinism.md) — why docker mode
  pins its own image and rendering settings.
