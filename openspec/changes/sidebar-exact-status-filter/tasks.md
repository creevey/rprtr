# Tasks

## 1. Exact status predicate

- [x] 1.1 Add failing tests in `tests/suite-filter.test.ts` for `filterTests` with `status:failed`: a failed test stays visible, skipped (`pending` with results) and discovered (`pending` without results) tests are excluded, and a running test stays visible until it settles (a passed rerun is excluded); verify `cd tests && bun test suite-filter.test.ts` fails against the current union predicate.
- [x] 1.2 Add failing tests for `status:pending`, `status:success`, and `status:approved`: pending includes both skipped and never-run tests, success excludes approved and running, and approved excludes success and running; verify `cd tests && bun test suite-filter.test.ts` fails.
- [x] 1.3 Replace the status union in `src/client/helpers/suite.ts` with exact equality against the requested status, plus the `status:failed` running-test exception; verify `cd tests && bun test suite-filter.test.ts` passes and `bun run typecheck` passes.

## 2. Hierarchy and view-only behavior

- [x] 2.1 Add failing tests proving a filtered tree keeps only ancestors of matches and omits suites with no matching descendants; verify `cd tests && bun test suite-filter.test.ts` fails before the predicate change if it still leaks non-matching statuses, and passes after.
- [x] 2.2 Add a test asserting filtering does not mutate test statuses, results, approvals, or suite statuses; verify `cd tests && bun test suite-filter.test.ts` passes and `bun run typecheck` passes.
- [x] 2.3 Add tests preserving text-only title matching (including a matching suite retaining descendants) and the existing combined text-plus-status precedence; verify `cd tests && bun test suite-filter.test.ts` passes.

## 3. Documentation and full gate

- [ ] 3.1 Add one sentence to the `README.md` sidebar section stating that status filters match test status exactly, skipped tests remain under `status:pending`, and `status:failed` keeps running reruns visible until they settle; verify `bun run format:check`.
- [ ] 3.2 Run the complete gate from the repository root: `bun run check` and `bun run test:playwright`; verify both exit 0.
