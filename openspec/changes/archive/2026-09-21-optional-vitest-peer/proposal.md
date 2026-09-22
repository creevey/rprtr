## Why

`3f0829f` added `vitest: ">=4 <5"` to `peerDependencies` with no `peerDependenciesMeta`, so npm treats it as required and auto-installs vitest into every consumer that installs `@crvy/rprtr`. A Playwright-only consumer gets ~44 packages it will never load, and in the repo's own `tests/fixtures/docker-smoke` fixture — whose rprtr comes from `file:./crvy-rprtr.tgz` — the resulting resolution crashes npm outright:

```
npm error Cannot read properties of null (reading 'edgesOut')
```

The Docker Smoke job has failed on every push to `main` since that commit. Reproduced on `node:22` (npm 10.9.8, linux) and fixed by marking the peer optional; it does not reproduce on macOS with any npm version, which is why it reads as green locally.

Both peers are genuinely optional: the package ships a Playwright reporter and a Vitest reporter, and no consumer needs both.

## What Changes

- `peerDependenciesMeta` marks `vitest` optional, so npm no longer installs it for a Playwright-only consumer and no longer crashes resolving the `file:` fixture.
- `@playwright/test` is marked optional on the same grounds — a Vitest-only consumer does not need it, and the reporter already resolves Playwright lazily.
- The reporter entry points fail with an actionable message, rather than a module-resolution error, when the peer a consumer actually needs is absent.
- The packaged contract is covered by a test that installs the packed tarball into a Playwright-only fixture and asserts vitest is absent from the resulting tree.

## Capabilities

### New Capabilities

- `package-surface`: what installing `@crvy/rprtr` puts in a consumer's dependency tree, and how the package behaves when an optional peer is missing. Without it, nothing states that the two reporters are independently usable, and the next dependency added for one runner can silently become mandatory for every consumer of the other — which is the regression this change fixes.

### Modified Capabilities

- None (no capability specs exist under `openspec/specs/` yet).

## Impact

- Published surface: `peerDependenciesMeta` added to `package.json`; `peerDependencies` ranges unchanged. Consumers who relied on the transitive vitest install must declare it themselves — noted in CHANGELOG.
- Code: `src/vitest.ts` and `src/reporter.ts` entry guards; no runtime dependency change.
- CI: unblocks the Docker Smoke job; the `publint` step in `bun run check` covers the manifest.
- Docs: `README.md` install section.

## Non-goals

- Splitting the package into `@crvy/rprtr` + `@crvy/rprtr-vitest`. The shared server, client, and artifact code make one package the right unit today.
- Widening or narrowing either peer range.
- Changing how the reporters resolve their runner at runtime beyond the error message.
- Fixing the other two failure modes on `main` — see the `green-ci-main` change.
