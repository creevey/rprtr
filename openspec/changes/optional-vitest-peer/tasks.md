## 1. Reproduce the failure as a test

- [x] 1.1 Add a packaging test that packs the current build, installs the tarball into a temporary Playwright-only fixture with npm, and asserts the install exits zero and no vitest package is present in the tree. Confirm it fails against the current manifest. Verify: `cd tests && bun test package-surface.test.ts` (expect failure)
- [x] 1.2 Add the mirror case — a temporary Vitest-only fixture — asserting the install succeeds and no Playwright test package is present. Verify: `cd tests && bun test package-surface.test.ts` (expect failure)

## 2. Make both peers optional

- [ ] 2.1 Add `peerDependenciesMeta` marking `vitest` and `@playwright/test` optional in `package.json`, leaving the ranges unchanged. Verify: `cd tests && bun test package-surface.test.ts`, `bun run build`
- [ ] 2.2 Confirm the original crash is gone end to end: pack, then `npm install` in `tests/fixtures/docker-smoke` on linux. Verify: `docker run --rm -v "$PWD:/w" -w /w node:22 sh -c 'cd tests/fixtures/docker-smoke && npm install'`

## 3. Entry-point guards

- [ ] 3.1 Write failing tests that importing the Vitest reporter without vitest installed, and configuring the Playwright reporter without the Playwright test package, each fail with a message naming the missing peer and the entry point that needs it. Verify: `cd tests && bun test package-surface.test.ts` (expect failures)
- [ ] 3.2 Implement the guards in `src/vitest.ts` and `src/reporter.ts`, using the project's standard error-extraction idiom and without adding a dependency. Verify: `cd tests && bun test package-surface.test.ts`, `bun run typecheck`

## 4. Docs and release

- [ ] 4.1 Note in `README.md` that each runner is an optional peer the consumer installs themselves, and add a CHANGELOG entry for consumers who relied on the transitive vitest install. Verify: `bun run format:check`
- [ ] 4.2 Full gate: `bun run check`
