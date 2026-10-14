import type { RunTestDescriptor } from '../schemas.ts'
import type { RecordSinks, RunContext, RunFilters } from './run-controller-types.ts'
import type { LaunchSpec } from './run-launcher.ts'

/**
 * Renders the one-line launch record: mode, runner, cwd, config, selection
 * size, update flag, and — for container launches — the resolved image and
 * container name. The record enumerates its fields, so no environment values
 * or command arguments can leak into it.
 */
export function renderLaunchRecord(
  mode: 'local' | 'docker',
  ctx: RunContext,
  filters: RunFilters,
  spec: LaunchSpec,
  tests: RunTestDescriptor[] | undefined,
): string {
  const runner = ctx.runner ?? 'playwright'
  const location = `mode=${mode} runner=${runner} cwd=${ctx.cwd} config=${ctx.configFile}`
  const selection = `tests=${tests === undefined ? 'all' : String(tests.length)} update=${filters.update === true}`
  const container =
    spec.container === undefined ? '' : ` image=${spec.container.image} container=${spec.container.name}`
  return `[RunController] run start ${location} ${selection}${container}`
}

export function emitLog(sinks: RecordSinks, message: string): void {
  if (sinks.log === undefined) console.log(message)
  else sinks.log(message)
}

export function emitWarn(sinks: RecordSinks, message: string): void {
  if (sinks.warn === undefined) console.warn(message)
  else sinks.warn(message)
}
