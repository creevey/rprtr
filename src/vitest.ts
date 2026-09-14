export class CrvyRprtrVitestReporter {
  // Lifecycle and options land in task 4.2 (vitest-browser-reporter change);
  // task 1.1 ships only the export surface.
  constructor(readonly options: Record<string, unknown> = {}) {}
}
export default CrvyRprtrVitestReporter
