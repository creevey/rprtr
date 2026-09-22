/** Canonical Docker image tag for a Playwright release; shared by docker mode, the Vitest sidecar, and pin remedies. */
export function playwrightImageTag(version: string): string {
  return `mcr.microsoft.com/playwright:v${version}-noble`
}

/** Env var carrying the image a Docker/sidecar-backed run actually uses, for offline pin resolution. */
export const DOCKER_IMAGE_ENV = 'CRVY_RPRTR_DOCKER_IMAGE'
