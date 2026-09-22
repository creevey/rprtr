## Why

The next release (0.4.0) would publish malformed release notes and cannot preview them: `publish.yml` prepends the generated section but never removes the hand-written `## [Unreleased]` block, so it survives duplicated in the published changelog; an orphaned `## [Unreleased]` and a literal `# test` sit at EOF since April; 40 of the 81 new commit subjects embed internal `(task N.M)` references; and `bun run changelog:preview` fails because `git-cliff --dry-run` no longer exists. Nothing in CI catches any of this.

## What Changes

- **publish.yml**: after `git-cliff --prepend`, run a tested cleanup script that removes every leftover `## [Unreleased]` section before staging CHANGELOG.md.
- **CHANGELOG.md**: one-time removal of the orphaned `## [Unreleased]` + `# test` at EOF (`CHANGELOG.md:483-484`); the curated top section stays and is consumed by the release.
- **cliff.toml**: strip `(task N.M)` / `(tasks ...)` from subjects via `commit_preprocessors`; skip `chore(openspec)` commits; group `ci:` commits under CI; fix `[github] repo` to `creevey/rprtr` (the repo was renamed; the slug still says `playwright-reporter`).
- **package.json**: fix `changelog:preview` to mirror the publish invocation into a temp file instead of the invalid `--dry-run`.
- **Release procedure**: after publishing, add the optional-peers migration note (`npm i -D vitest`) to the GitHub Release body manually — no `skip_changelog` workflow input.
- **Bookkeeping**: tick `green-ci-main` 5.2 (main CI is green) and `vitest-passing-visual-tests` 4.1 after its scenario review, keeping both changes strict-valid.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

None — this is release tooling, so the change sets `skip_specs: true`, matching the `green-ci-main` and `extract-reporter-transport` precedent. Without it: 0.4.0 publishes a duplicate stale `[Unreleased]` section, internal task IDs, a literal `# test`, and links to the renamed repo slug; `changelog:preview` remains unrunnable.

## Impact

`.github/workflows/publish.yml`, `cliff.toml`, `CHANGELOG.md`, `package.json`, `scripts/` (new cleanup script plus its test), `tests/`; OpenSpec bookkeeping in `green-ci-main` and `vitest-passing-visual-tests`. No runtime, build, dependency, or published-package-surface changes; no `docs/*.md` product pages affected.

## Non-goals

- `skip_changelog` / prepared-changelog mode in `publish.yml`
- Full-history CHANGELOG regeneration or restoring compare-link footers
- A curated-notes pipeline; generated notes stay the source
- Archiving the 13 completed changes (separate follow-up after the tag)
- A standing release runbook page in `docs/`
