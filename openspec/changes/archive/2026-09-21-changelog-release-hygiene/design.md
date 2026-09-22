## Context

See proposal.md — Why. Constraints that shape the approach:

- `publish.yml` generates notes with `git-cliff --unreleased --tag <next> --prepend CHANGELOG.md`, then stages only `package.json` and `CHANGELOG.md` (`publish.yml:95-108`). The generated section is inserted after the configured header, so anything already below (the curated `## [Unreleased]`, the EOF orphan) survives untouched.
- The repo already treats release-gate scripts as tested modules: `scripts/check-lockfiles.ts` exports a pure function covered by `tests/check-lockfiles.test.ts`, and `bun run check` wires scripts into the gate.
- git-cliff is 2.13.1 locally; `--dry-run` was removed. `--bumped-version` currently prints `v0.4.0` and skips 15 unconventional commits (merges), matching the expected minor bump.
- Of 81 commit subjects since v0.3.3, 40 carry `(task N.M)`-style refs and one (`chore(vitest): check off completed task 1.2 checkbox`) mentions a task without parentheses.
- No new dependency or published-package change is involved: the cleanup uses Bun built-ins, git-cliff is already the release tool, and `scripts/` is not in the `files` list, so the npm surface (exports map, bin, peer dependencies, `dist/`) is untouched.

## Goals / Non-Goals

**Goals:**

- The published 0.4.0 changelog contains exactly one section per release and no internal process markers.
- `bun run changelog:preview` runs and shows what the release will generate.
- The cleanup is verified by a unit test, not by cutting a release.

**Non-Goals:**

- Changing what git-cliff generates beyond parsers/preprocessors (no template rewrite).
- Making commit history retroactively clean — only future generation is filtered.

## Decisions

### D1: `[Unreleased]` sweep as a tested script, not inline awk

New module `scripts/strip-unreleased-changelog.ts` exporting a pure `stripUnreleasedSections(markdown): { markdown, removed }`, plus a thin CLI that rewrites the file in place and prints the removed count. Invoked by `publish.yml` after note generation and before `git add`, and usable locally against a copy.

Semantics: a section starts at a line matching `^## \[Unreleased\]\s*$`, ends before the next `^## \[` heading or EOF; the heading, body, and one adjacent separator blank line are removed. Idempotent (removing zero sections is success).

No existing module covers "remove a Markdown section" — `scripts/check-lockfiles.ts` is the closest, and only as a structural precedent for a tested `scripts/` module.

Alternatives: inline `awk` in the workflow — rejected: untestable, no failure signal until a release publishes garbage; a generic "delete until next release heading" script living in `.github/` — rejected: `scripts/` is where `check-lockfiles.ts` already sets this precedent, and the CLI must be runnable pre-release.

### D2: Task-ID stripping via two digit-anchored preprocessors

`cliff.toml` gains:

```toml
commit_preprocessors = [
  { pattern = '''\s*\(tasks? [\d.,\s-]+\)''', replace = "" },
  { pattern = '''\stasks? \d+(\.\d+)*''', replace = "" },
]
```

The first covers 39 of 40 observed forms (parenthesized lists/ranges). The second handles the bare `task 1.2` prose mention. Digit anchoring keeps legitimate parentheticals (e.g. "task force") intact.

Alternatives: broad `\(task[^)]*\)` — rejected: can eat unrelated prose; manual curation at release — rejected: doesn't scale and is the status quo that produced 40 leaked refs.

### D3: Skip `chore(openspec)` commits

Parser `{ message = "^chore\\(openspec\\)", skip = true }` before the generic `^chore` parser. Archive/bookkeeping commits are not user-facing; the underlying work is already represented by `feat`/`fix` entries. Alternative: regroup under Miscellaneous — rejected: still noise.

### D4: `ci:` parser gets an explicit `CI` group

`{ message = "^ci", group = "CI" }` before the generic parsers. The current output renders `### Ci` via upper-first of the raw type. Cosmetic but free.

### D5: Fix `[github] repo` slug to `creevey/rprtr`

`cliff.toml:63` still says `playwright-reporter`; the repo was renamed (`CHANGELOG.md` 0.0.3 already fixed URLs elsewhere). Prepend does not write footers, so no historical links are rewritten.

### D6: `changelog:preview` prints the generated section with an inferred tag

`"changelog:preview": "git-cliff --unreleased --bump"` — stdout, no file writes, no shell chaining. The workflow's actual tag comes from its `bump_type` input; the preview header (`v0.4.0` today) is informational.

Alternatives: temp-file chain that copies CHANGELOG, prepends, sweeps, and diffs — rejected: duplicates publish state in a shell one-liner for marginal fidelity, and the sweep's own test plus a release-day verification task cover the merge; explicit `TAG=v0.4.0 bun run changelog:preview` override cannot pass args through the script cleanly and is unnecessary.

### D7: Migration note goes to the GitHub Release body, not the changelog pipeline

One manual step after publish for 0.4.0 only: prepend the optional-peers migration line (`npm i -D vitest`) to the release body. No `skip_changelog` input, no prepared-changelog mode (deferred; see proposal Non-goals).

Hazard: never pre-bump `package.json` before triggering the workflow — `publish.yml:101` skips the commit _and the tag push_ when nothing is staged.

### D8: Bookkeeping stays in the two open changes

Tick `green-ci-main` 5.2 (main CI run `35561728900` is green) and `vitest-passing-visual-tests` 4.1 after its scenario review; re-run `openspec validate --strict` on both. Archiving remains a post-tag follow-up.

## Risks / Trade-offs

- [Sweep deletes a deliberate future `## [Unreleased]` section a maintainer wanted kept] → the heading is reserved for release staging; the test pins the semantics, and the curated section's content is expected to be superseded by generated entries.
- [Preprocessors blunt a future commit message containing "task 5"] → digit-anchored patterns; the only realistic false positive is deliberate prose, which can be reworded at commit time.
- [`--bump` infers a different bump than the workflow input] → preview-only header text; the release-day task verifies the actual generated section.
- [CHANGELOG edit before release conflicts with the release commit] → no open PRs; cleanup lands on main before the workflow runs.
- [Script silently removes nothing when the file format drifts] → unit test fixtures include both the top curated section and the EOF orphan; release-day verification asserts `grep -c '^## \[Unreleased\]' CHANGELOG.md` is 0 after publish.

## Migration Plan

1. Land the change (script + test, cliffs, workflow step, one-time CHANGELOG cleanup, both task ticks) through the normal gate.
2. Trigger the 0.4.0 publish (`bump_type: minor`).
3. Verify post-release: no `## [Unreleased]` remains in `CHANGELOG.md`, generated 0.4.0 section has no `(task` refs, release body carries the migration note.
4. Post-tag follow-up (separate): archive the 13 completed changes, delete the stale `pr-2-vitest` branch.

Rollback: the sweep step is additive to the workflow; reverting that one commit restores prior behavior without touching released artifacts. The one-time CHANGELOG cleanup is recoverable from git history.
