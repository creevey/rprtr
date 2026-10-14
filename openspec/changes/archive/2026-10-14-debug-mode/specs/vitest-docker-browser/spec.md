# Spec Delta

## ADDED Requirements

### Requirement: Sidecar failure evidence is preserved

When a sidecar container fails to start or never becomes ready, the server SHALL record the resolved image, the container name, and — when the container is still present — its inspect state (exit code and error, when any) and a bounded tail of its logs, before removing the container. In debug mode a failed sidecar container SHALL be retained for inspection instead of removed. Recording evidence SHALL NOT change the failure outcome: the run still fails with `docker-unavailable` and no test process spawns.

#### Scenario: Readiness failure records evidence before removal

- **WHEN** the sidecar container starts but its endpoint never accepts connections
- **THEN** the server records the image, container name, inspect state, and recent logs, and removes the container afterwards

#### Scenario: Already-removed container degrades gracefully

- **WHEN** the sidecar container has already exited and been auto-removed before its evidence can be read
- **THEN** the failure still surfaces as `docker-unavailable` without an internal error

#### Scenario: Debug mode retains the failed sidecar

- **WHEN** debug mode is enabled and the sidecar fails to start or become ready
- **THEN** the container is retained and the debug record names the `docker logs`/`docker inspect` commands that inspect it

#### Scenario: Normal disposal is unchanged

- **WHEN** the server disposes a healthy sidecar on shutdown or force-kill
- **THEN** the container is removed exactly as before
