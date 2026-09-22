import type { FullConfig } from '@playwright/test'

import {
  buildRunEnvironments,
  evaluateBrowserPinPolicy,
  resolveProjectPins,
  type BrowserPinPolicy,
  type PinBrowser,
  type RunEnvironments,
} from './browser-pins.ts'
import { DOCKER_IMAGE_ENV } from './docker-image.ts'
import type { BrowserTypeLike } from './reporter-browser-types.ts'

export interface ResolveEnvironmentsInput {
  config: FullConfig
  cwd: string
  policy: BrowserPinPolicy
  browserTypes: Record<PinBrowser, BrowserTypeLike>
}

/**
 * Reads declared pins, resolves the effective build for every project, and applies the
 * pin policy. Invalid pins throw here — before any test runs.
 */
export function resolveRunEnvironments(input: ResolveEnvironmentsInput): RunEnvironments {
  const projects = resolveProjectPins({ configMetadata: input.config.metadata, projects: input.config.projects })
  const environments = buildRunEnvironments({
    cwd: input.cwd,
    projects,
    executablePathFor: (browser) => input.browserTypes[browser].executablePath(),
    dockerImage: process.env[DOCKER_IMAGE_ENV],
  })
  for (const [projectName, environment] of Object.entries(environments)) {
    const decision = evaluateBrowserPinPolicy({ policy: input.policy, projectName, environment })
    if (decision.action === 'fail') throw new Error(decision.message)
    if (decision.action === 'warn') console.warn(`[CrvyRprtr] ${decision.message}`)
  }
  return environments
}
