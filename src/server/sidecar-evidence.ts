import { boundExcerpt, formatRecord, type DebugLogger } from '../debug-log.ts'
import type { DockerExec, DockerExecResult } from './docker-support.ts'

/** Bounded tail length for a failed container's logs. */
const FAILURE_LOG_TAIL = 50

export interface SidecarEvidenceDeps {
  exec: DockerExec
  containerName: string
  /** With debug on the evidence record goes to the debug sink and the container is retained. */
  debug?: DebugLogger
  /** Terminal sink for the unconditional evidence record; defaults are applied by the caller. */
  log: (message: string) => void
}

/** Evidence must never replace the failure outcome: an unreachable daemon degrades to null. */
async function safeExec(exec: DockerExec, args: string[]): Promise<DockerExecResult | null> {
  try {
    return await exec(args)
  } catch {
    return null
  }
}

function parseInspectState(stdout: string, fields: Record<string, string | number | undefined>): void {
  const [status, exitCodeText, ...errorParts] = stdout.trim().split(/\s+/)
  if (status !== undefined && status !== '') fields.state = status
  const exitCode = Number(exitCodeText)
  if (Number.isInteger(exitCode)) fields.exitCode = exitCode
  const error = errorParts.join(' ').trim()
  if (error !== '') fields.error = error
}

/**
 * Failure evidence for a sidecar that failed to start or become ready: the
 * resolved image and container name always, plus the container's inspect state
 * (exit code and error, when any) and a bounded log tail when it is still
 * present. The inspect/logs commands stay named for manual follow-up.
 */
async function captureFailureEvidence(
  deps: SidecarEvidenceDeps,
  image: string,
): Promise<Record<string, string | number | undefined>> {
  const fields: Record<string, string | number | undefined> = {
    image,
    container: deps.containerName,
    inspect: `docker inspect ${deps.containerName}`,
    logs: `docker logs --tail ${FAILURE_LOG_TAIL} ${deps.containerName}`,
  }
  const state = await safeExec(deps.exec, [
    'inspect',
    '--format',
    '{{.State.Status}} {{.State.ExitCode}} {{.State.Error}}',
    deps.containerName,
  ])
  if (state !== null && state.exitCode === 0) parseInspectState(state.stdout, fields)
  const tail = await safeExec(deps.exec, ['logs', '--tail', String(FAILURE_LOG_TAIL), deps.containerName])
  if (tail !== null && tail.exitCode === 0) {
    const output = `${tail.stdout}${tail.stderr}`.trim()
    if (output !== '') fields.logTail = boundExcerpt(output)
  }
  return fields
}

/**
 * Records the evidence (terminal-only) before the failure-path removal. In
 * debug mode the record goes to the debug sink instead, and the caller retains
 * the container.
 */
export async function recordSidecarFailure(deps: SidecarEvidenceDeps, image: string): Promise<void> {
  const fields = await captureFailureEvidence(deps, image)
  const line = formatRecord('BrowserSidecar', { event: 'sidecar-failed', ...fields })
  if (deps.debug?.enabled === true) deps.debug.log(line)
  else deps.log(line)
}
