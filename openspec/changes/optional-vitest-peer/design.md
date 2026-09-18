## Context

See proposal.md — Why.

The npm crash is worth pinning down, because the fix has to be justified by more than "it makes the error go away". `tests/fixtures/docker-smoke/package.json` declares `@crvy/rprtr: file:./crvy-rprtr.tgz` plus `@playwright/test`, and nothing else. With `vitest` a required peer, npm's arborist must graft vitest and its whole optional-native subtree onto a node whose source is a local tarball, and dereferences a null edge while doing so. The reproduction is exact and the fix is confirmed:

| tarball                                               | `npm install` on `node:22` / linux                              |
| ----------------------------------------------------- | --------------------------------------------------------------- |
| current `0.3.3`                                       | `npm error Cannot read properties of null (reading 'edgesOut')` |
| same tarball + `peerDependenciesMeta.vitest.optional` | succeeds                                                        |

macOS/arm64 never reproduces it, on npm 10.9.4, 11.7.0 or 12. So the fixture install is the visible symptom; the mandatory peer is the defect, and it would be worth fixing even if arborist handled it gracefully.

The two entry points are asymmetric, which matters for the guards. `src/vitest.ts` imports from `vitest/node` with `import type` only, so nothing resolves vitest at runtime: with the peer absent, `@crvy/rprtr/vitest` imports and constructs happily and then simply never runs. `src/reporter.ts` imports `chromium, firefox, webkit` from `@playwright/test` as _values_ at module scope, so ESM resolves the peer before the module body runs and `@crvy/rprtr` fails with `ERR_MODULE_NOT_FOUND` naming `dist/reporter.js`. Confirmed against the packed tarball in a project with neither runner installed.

So the manifest is not the only thing that disagrees: one entry point fails too early to say anything useful, the other does not fail at all.

## Goals / Non-Goals

**Goals:**

- The manifest matches how the code is already organised: two independent reporters, one package.
- The peer contract is verified against a real install, not asserted in a comment, so the next runner integration cannot regress it.

**Non-Goals:**

- Converting _all_ module-scope imports to dynamic ones. Only the `@playwright/test` value import moves, because it is the one that makes the guard unreachable; the exported shape does not change.

## Decisions

**Mark both peers optional, not just `vitest`.** Fixing only the peer that happens to be crashing CI leaves the same latent asymmetry pointed the other way: a Vitest-only consumer still pulls Playwright. The spec is written about "supported runners" rather than about vitest for the same reason. Alternative considered: dropping `vitest` from `peerDependencies` entirely — rejected, because the range is real information (`>=4 <5`) and an optional peer still gets version-checked when present.

**Guard the entry points with a named error, each in the way its entry point needs.** With optional peers, a consumer who reaches a reporter whose runner is missing gets either a module-resolution error naming an internal file (Playwright) or silence (Vitest). Neither says what to install. Both guards live in the reporter constructor, so the failure lands where the consumer configured the reporter:

- **Playwright.** The module-scope `chromium, firefox, webkit` import becomes a synchronous `createRequire` load inside the constructor, behind the existing `seams.browserTypes` defaults — the only place those values are used. This is what makes a guard reachable at all; a guard in the module body runs after ESM has already failed to resolve the import. `createRequire` rather than `await import` keeps the constructor synchronous and the exported shape unchanged, and works in both the ESM and CJS builds (`import.meta.url` is already polyfilled in the CJS output).
- **Vitest.** There is no error to improve, so the guard is an explicit `import.meta.resolve('vitest')` presence check. The `./vitest` export is ESM-only, so `import.meta.resolve` is available; the type-only import stays as it is.

Alternative considered: leaving it to the module loader — rejected, because making the peer optional is precisely what makes these failures reachable, so the change owns them.

**Verify by installing the packed tarball into a single-runner fixture.** `publint` checks manifest well-formedness but will not catch a peer that is required-but-shouldn't-be. The `docker-smoke` fixture is already a Playwright-only project that installs the packed tarball, so the check has a home; it needs an assertion that vitest is absent from the tree, and a second fixture for the mirror case. This also means the original crash is covered by a test that would have caught it.

## Risks / Trade-offs

- **A consumer today relies on the transitive vitest install and breaks on upgrade.** → Realistically only a Vitest consumer who omitted vitest from their own devDependencies, which npm would already be warning about. CHANGELOG note; the fix on their side is one line.
- **Optional peers hide a genuine version mismatch behind a runtime error instead of an install-time one.** → The entry-point guard reports the missing package by name; a _present but out-of-range_ peer still warns at install as before.
- **The arborist crash may be an npm bug that a future npm release fixes**, making the change look unnecessary. → The mandatory-peer defect stands on its own; the crash is evidence, not the rationale.

## Migration Plan

Patch or minor release. Consumers who need both runners are unaffected. No data migration; reverting is restoring the manifest field.
