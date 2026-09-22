/**
 * Docker-mode environment contract: two names exported into the container only,
 * so project configs can derive host-addressed `webServer.url` / `baseURL` values.
 * Local runs and sidecar-backed Vitest runs (whose test process stays on the host)
 * never see either name.
 */

/** Marker meaning "this process runs inside the rprtr container". */
export const DOCKER_MODE_ENV = 'CRVY_RPRTR_DOCKER'

/** Host gateway hostname reachable from inside the container, wired by `--add-host`. */
export const DOCKER_HOST_GATEWAY_ENV = 'CRVY_RPRTR_HOST_GATEWAY'

/** The gateway hostname `buildDockerRunArgs` adds to the container's `/etc/hosts`. */
export const DOCKER_HOST_GATEWAY = 'host.docker.internal'
