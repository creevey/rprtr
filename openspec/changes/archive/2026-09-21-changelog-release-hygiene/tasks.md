## 1. Cleanup script (test-first)

- [x] 1.1 Write failing `tests/strip-unreleased-changelog.test.ts` covering: a curated top `## [Unreleased]` section with body and following separator is removed; an EOF orphan (`## [Unreleased]` + `# test` with nothing after it) is removed; a file with no `[Unreleased]` section is returned byte-for-byte; running twice is idempotent; every other release section survives unchanged. Verify: `cd tests && bun test strip-unreleased-changelog.test.ts` (new cases fail)
- [x] 1.2 Implement `scripts/strip-unreleased-changelog.ts`: pure `stripUnreleasedSections(markdown)` returning `{ markdown, removed }` plus a CLI that rewrites the file in place and prints the removed count. Verify: `cd tests && bun test strip-unreleased-changelog.test.ts` passes, then `bun run typecheck`

## 2. git-cliff generation filters

- [x] 2.1 Edit `cliff.toml`: add the two digit-anchored `commit_preprocessors` from design D2, add `{ message = "^chore\\(openspec\\)", skip = true }`, add `{ message = "^ci", group = "CI" }`, and set `[github] repo = "rprtr"` (design D2–D5). Verify: `git-cliff --unreleased --tag v0.4.0 2>/dev/null | grep -cE '\(task|^### Ci$|chore\(openspec\)'` prints `0`, and the same command with `grep -c '^### CI$'` prints `1`
- [x] 2.2 Spot-check the regenerated section end to end: it still lists the Vitest Added entries, the optional-peers fix entry survives, and no line contains an internal task reference. Verify: `git-cliff --unreleased --tag v0.4.0 2>/dev/null | sed -n '1,60p'`

## 3. Release wiring and preview

- [x] 3.1 One-time `CHANGELOG.md` cleanup: remove only the orphaned EOF `## [Unreleased]` + `# test` block (`CHANGELOG.md:483-484`); keep the curated top section as the source for the release-body migration note (design D7). Verify: `grep -n '^## \[Unreleased\]' CHANGELOG.md` lists only line 8, `grep -c '^# test' CHANGELOG.md` prints `0`, and `tail -3 CHANGELOG.md` ends the 0.0.1 section
- [x] 3.2 Add a `publish.yml` step that runs `bun scripts/strip-unreleased-changelog.ts CHANGELOG.md` after "Generate CHANGELOG.md" and before "Commit and tag release" (design D1). Verify with a temp-copy dry run: `tmp=$(mktemp -d) && cp CHANGELOG.md "$tmp/" && git-cliff --unreleased --tag v0.4.0 --prepend "$tmp/CHANGELOG.md" 2>/dev/null && bun scripts/strip-unreleased-changelog.ts "$tmp/CHANGELOG.md" && grep -c '^## \[Unreleased\]' "$tmp/CHANGELOG.md"` prints `0` and `grep -c '(task' "$tmp/CHANGELOG.md"` prints `0`
- [x] 3.3 Fix the `changelog:preview` script in `package.json` to `git-cliff --unreleased --bump` (design D6). Verify: `bun run changelog:preview | sed -n '9p'` prints the `## [0.4.0] - <date>` heading and `bun run changelog:preview | grep -c '(task'` prints `0`

## 4. OpenSpec bookkeeping

- [x] 4.1 Tick `green-ci-main` task 5.2 now that main CI run `35561728900` passes all five jobs, including Docker Smoke. Verify: `openspec validate green-ci-main --strict`
- [x] 4.2 Review the Vitest Browser Mode docs (`README.md` lines 184–221 and `examples/vitest-browser/README.md`) against the `vitest-passing-visual-tests` spec scenarios, then tick its task 4.1 if each scenario is covered; if a gap is found, fix the doc instead of ticking. Verify: `openspec validate vitest-passing-visual-tests --strict` plus the review outcome recorded in the commit message

## 5. Full gate

- [x] 5.1 Run the full gate and strict-validate this change; no browser behavior changed, so `bun run test:playwright` is not required. Verify: `bun run check && openspec validate changelog-release-hygiene --strict`
