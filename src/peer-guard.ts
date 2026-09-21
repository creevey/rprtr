/**
 * Both test runners are optional peer dependencies (see `peerDependenciesMeta`),
 * so a consumer can reach a reporter whose runner was never installed. Left
 * alone, Playwright's absence surfaces as a module-resolution error naming a
 * file inside `dist/`, and Vitest's absence surfaces as nothing at all — the
 * reporter constructs and is then never called. Both guards below turn that
 * into a message naming the package to install and the entry point that wants
 * it.
 */
export function missingPeerError(peer: string, entryPoint: string, cause: unknown): Error {
  // Node appends a require stack pointing into dist/; the first line carries the
  // useful part and the rest is what this message exists to replace.
  const detail = (cause instanceof Error ? cause.message : String(cause)).split('\n')[0] ?? ''
  return new Error(
    `${entryPoint} requires the optional peer dependency "${peer}", which is not installed. ` +
      `Install ${peer} to use this reporter.\n  ${detail}`,
  )
}

/**
 * `vitest` is imported by the Vitest reporter for types only, so nothing
 * resolves it at runtime: without this check the reporter constructs fine in a
 * project with no Vitest and then silently never runs.
 */
export function ensureVitestInstalled(): void {
  try {
    import.meta.resolve('vitest')
  } catch (error) {
    throw missingPeerError('vitest', '@crvy/rprtr/vitest', error)
  }
}
