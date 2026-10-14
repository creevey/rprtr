# Spec Delta

## ADDED Requirements

### Requirement: Host services run where the tests run

Under docker run mode, Playwright tests and their `webServer` entries SHALL run on the host, so host-addressed `webServer.url` and `use.baseURL` values remain valid as written, including loopback addresses. Container browsers SHALL reach host loopback services through the browser sidecar's loopback exposure rather than through a host-gateway hostname. Configurations written for the retired gateway contract — deriving addresses from `CRVY_RPRTR_HOST_GATEWAY` with a `localhost` fallback — SHALL continue to work unchanged on the host.

#### Scenario: Loopback webServer needs no gateway recipe

- **WHEN** docker mode prepares a run whose config declares a loopback `webServer`
- **THEN** the service starts or is reused on the host and the run proceeds without a gateway rewrite

#### Scenario: Gateway recipe keeps working

- **WHEN** a config derives its `webServer.url` or `baseURL` from `CRVY_RPRTR_HOST_GATEWAY` with a `localhost` fallback
- **THEN** the run uses the host address because the variable is unset on the host

#### Scenario: No divergence diagnostics are produced

- **WHEN** docker mode prepares a run
- **THEN** the server does not probe host services and does not emit or persist divergence notices

## REMOVED Requirements

### Requirement: Host gateway environment contract

**Reason**: No Playwright test process runs inside the container anymore, so nothing consumes a host-gateway contract; the test process and host services are host-local by construction.
**Migration**: Remove reliance on `CRVY_RPRTR_DOCKER` / `CRVY_RPRTR_HOST_GATEWAY`. Existing `const host = process.env.CRVY_RPRTR_HOST_GATEWAY ?? 'localhost'` recipes keep working unchanged because the variable is unset.

### Requirement: Docker-mode host-service divergence diagnostic

**Reason**: The diagnostic described divergence between an in-container test process and host services; with the test process on the host there is no divergence to diagnose.
**Migration**: Delete the probes, warning table, and related tests. A loopback `webServer` or `baseURL` now simply resolves on the host.

### Requirement: Divergence warnings reach the live UI

**Reason**: Divergence warnings no longer exist as a concept, so the delivery requirement is dead code.
**Migration**: Remove the `notices` fields from run-status messages and their client rendering; static and offline artifacts remain unchanged event-derived outputs.
