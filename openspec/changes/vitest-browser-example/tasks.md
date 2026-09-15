# Tasks: vitest-browser-example

All example commands run inside `examples/vitest-browser/` unless stated otherwise.

## 1. Scaffold

- [x] 1.1 Create `examples/vitest-browser/` skeleton: `package.json` (private, scripts `test`/`test:ci`/`update-snapshots`/`reporter`, exact-pinned `vitest@4.1.11`, `@vitest/browser-playwright@4.1.11`, `playwright@1.59.0`, `@crvy/rprtr@^0.3.3`), `vitest.config.ts` (browser mode + playwright provider + chromium instance + `new CrvyRprtrVitestReporter()` with no options), `tsconfig.json`, `.gitignore` (node_modules, `.vitest-attachments/`, `crvy-rprtr-*.json`, `crvy-rprtr.html`, `screenshots/`). Verify: `cd examples/vitest-browser && bun install && bunx vitest run` (starts Chromium, exits cleanly with "no test files found")
- [x] 1.2 Root `package.json`: add `example:vitest` script (`cd examples/vitest-browser && bunx vitest run`). Verify: `bun run example:vitest` from the repo root

## 2. Components and tests

- [x] 2.1 Write `src/button.js` and `src/expandable.js` (vanilla DOM factories, one with internal state) and `tests/button.test.ts` / `tests/expandable.test.ts`: DOM assertions for rendered props/update, a click-then-assert interaction, and `toMatchScreenshot('…')` on a locator in each file. Verify: `bunx vitest run` — DOM/interaction tests pass; visual tests fail once creating references (expected first-run UX) — then `bunx vitest run` again green
- [x] 2.2 Typecheck the example standalone. Verify: `cd examples/vitest-browser && bunx tsc --noEmit`

## 3. Baselines

- [x] 3.1 Regenerate + commit `-chromium-darwin` references (fresh `vitest run --update`, review images, commit). Verify: `bunx vitest run` green on darwin with a clean checkout (`git stash` of outputs not needed — references are tracked)
- [x] 3.2 Generate + commit `-chromium-linux` references via the official container (`docker run --rm -v "$PWD":/work -w /work mcr.microsoft.com/playwright:v1.59.0-noble` running `bunx vitest run --update` with node fallback, or a local CI-triggered run). Verify: committed `*-linux.png` files exist beside the darwin ones

## 4. README

- [x] 4.1 Write `examples/vitest-browser/README.md` per design Decision 7: architecture diagram, requirements, quickstart (two terminals), first-run UX, the approve loop (edit color constant in `src/`, rerun, diff, Approve, rerun), `test:ci` artifacts, `update-snapshots`, limitations + forward link to `vitest-runner`, FAQ (port conflicts, new-platform baselines, intentional redesigns). Verify: manual walkthrough of every command in the quickstart from a clean state

## 5. CI wiring

- [x] 5.1 `.github/workflows/ci.yml`: install step for `examples/vitest-browser` in `lint-and-typecheck`; install + `bun run example:vitest` step in the `playwright-tests` container job (validates `-linux` baselines and the offline-artifact path). Verify: workflow YAML reviewed; suite passes in CI on the PR
- [x] 5.2 `.github/workflows/publish.yml`: mirror the component-testing install step for the new example. Verify: YAML diff reviewed against the CT step

## 6. Main README

- [x] 6.1 Root `README.md`: link the new example from the Vitest Browser Mode section (like the Component Testing section does) and remove the stale "Approving Vitest screenshots is not supported yet" limitation line (shipped in `vitest-approval`). Verify: manual review against shipped behavior

## 7. Gate

- [ ] 7.1 Full gate + browser regression (repo-level, no product code changed but CI/UI-adjacent files touched). Verify: `bun run check && bun run test:playwright`
