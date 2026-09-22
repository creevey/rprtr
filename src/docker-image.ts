/** Canonical Docker image tag for a Playwright release; shared by docker mode, the Vitest sidecar, and pin remedies. */
export function playwrightImageTag(version: string): string {
  return `mcr.microsoft.com/playwright:v${version}-noble`
}
