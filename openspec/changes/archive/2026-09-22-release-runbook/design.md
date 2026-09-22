# Design

## Context

See `proposal.md` — Why. Current state that shapes the approach:

- The release vehicle is `.github/workflows/publish.yml` (`workflow_dispatch`, input `bump_type: patch|minor|major`). It derives the next version from `git describe --tags --abbrev=0` (falling back to `v0.0.0`), overwrites `package.json`'s version, prepends the git-cliff section (`--unreleased --tag vX.Y.Z --prepend CHANGELOG.md`), strips hand-written `[Unreleased]` sections via `scripts/strip-unreleased-changelog.ts`, commits `chore(release): bump to vX.Y.Z`, pushes, tags and pushes the tag, builds, `npm publish --provenance --access public`, extracts release notes from `CHANGELOG.md`, and creates the GitHub release. It is not resumable: a second dispatch after the tag exists computes the next version past the unpublished one.
- Publishing authenticates in CI (the workflow carries `id-token: write` and no registry token); local npm credentials are not part of the supported path.
- Changelog tooling already exists: `cliff.toml`, `bun run changelog:preview` (`git-cliff --unreleased --bump`), and `scripts/strip-unreleased-changelog.ts`. git-cliff writes INFO/WARN lines to stderr and the changelog to stdout; an unreleased range with no entries renders zero bullet lines and still exits 0.
- Repo script conventions: Bun TypeScript under `scripts/` with an `import.meta.main` CLI guard, pure functions exported and unit-tested from `tests/` (for example `scripts/strip-unreleased-changelog.ts` and `scripts/check-lockfiles.ts`). `bun run check` (lint, typecheck, format:check, knip, test:bun, duplicates, lockfiles, publint) is the same gate CI runs; oxfmt formats Markdown too, including skill files.
- Agent tooling lives in `.opencode/skills/<name>/SKILL.md` and `.claude/skills/<name>/SKILL.md`; the openspec-generated pairs differ only in platform-specific prompt syntax, so a hand-written procedure can be byte-identical in both.
- Remote-tracking refs can be stale: the current checkout's `origin/main` was one release behind until a fetch revealed `v0.4.1` tagged and published. The sync gate must fetch; it cannot trust `origin/main` as-is.

## Goals / Non-Goals

**Goals:** one fail-closed preflight command that turns every dispatch precondition into a machine-checkable gate; an agent-executable procedure with an explicit confirmation gate before irreversible actions; recovery guidance keyed to the furthest completed release stage; identical skill copies in both agent tooling directories; zero new dependencies; no runtime, package-surface, or workflow changes.

**Non-Goals:** making `publish.yml` resumable or restructuring it; automated or local publishing; a `crvy-rprtr release` subcommand; inferring the bump type (the maintainer chooses it); a GitHub Actions API status gate beyond `bun run check`; changing `cliff.toml` or the versioning scheme.

## Decisions

### 1. The procedure is a skill, not a docs page or a slash command

The runbook ships as `.opencode/skills/release-runbook/SKILL.md` mirrored to `.claude/skills/release-runbook/SKILL.md`. A skill is description-triggered, so an agent asked to "cut a release" finds it without a memorized command; the repo already distributes agent instructions this way. A `docs/release-runbook.md` would be a second, non-invocable source of truth; a slash command would duplicate the skill with less discoverability. The two copies stay byte-identical (no platform-specific syntax is needed) and a test asserts it, because openspec's own generated pairs have already drifted once.

### 2. Preflight is `scripts/release-preflight.ts`, pure core plus a spawn seam

The script follows `scripts/strip-unreleased-changelog.ts`: exported pure functions, an `import.meta.main` CLI, tests under `tests/`. The pure model (option parsing, version arithmetic, changelog counting, report rendering) lives in `scripts/release-preflight-core.ts` so each file stays within the repo's `max-lines` rule; the gate evaluators and CLI stay in `scripts/release-preflight.ts`. Argument parsing uses Zod, per the project's boundary-validation convention. Shelling out goes through one injectable command runner (`Bun.spawnSync` in production) so gate evaluation is unit-testable with recorded command results instead of a live repository. `package.json` gains `"release:preflight": "bun scripts/release-preflight.ts"`. Alternatives rejected: a shell script (no structured JSON, weak testability), extending `scripts/check.sh` (different lifecycle and consumers), and inlining logic in `package.json` (untestable).

### 3. Gate set, order, and fail-closed aggregation

Gates run in this order; each reports `pass`, `fail`, or `skipped`, and `ready` is true only when every gate is `pass`. Any `fail` or `skipped` exits non-zero.

| Gate        | Evidence                                                                                 | Remediation on failure                            |
| ----------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `worktree`  | `git rev-parse --git-dir` succeeds                                                       | Run from the repository checkout                  |
| `branch`    | `git symbolic-ref --short -q HEAD` equals the release branch (default `main`)            | Switch to the release branch                      |
| `clean`     | `git status --porcelain` is empty                                                        | Commit or stash all changes                       |
| `sync`      | after `git fetch`, `git rev-list --left-right --count HEAD...<remote>/<branch>` is `0 0` | Pull or push so local and remote match            |
| `changelog` | `git-cliff --unreleased --tag <next>` renders at least one entry line                    | Land a releasable commit or choose the right bump |
| `tag`       | the next tag is absent locally and from `git ls-remote --tags <remote>`                  | Choose a different bump                           |
| `registry`  | `npm view @crvy/rprtr@<next> version` does not resolve                                   | Choose a different bump                           |
| `auth`      | `gh auth status` exits 0                                                                 | `gh auth login`                                   |
| `checks`    | `bun run check` exits 0                                                                  | Fix the failing check                             |

`checks` is the slow gate and runs last: when any earlier gate fails, `checks` is reported `skipped` (never `pass`), which keeps `ready` false. `--fast` skips `checks` explicitly for state diagnosis; per the spec it still exits non-zero and reports `ready: false`.

### 4. Output contract: table by default, JSON for agents, no credential material

Default output is a per-gate table with a summary (`current → next`, ready/not ready) and remediations. `--json` emits one document: `{ bump, branch, currentVersion, nextVersion, nextTag, ready, gates: [{ id, status, detail, remediation? }] }`. Exit codes: `0` ready, `1` not ready, `2` usage error. The `auth` gate reports fixed state strings only — never `gh auth status` output, which includes a token prefix. No command environment or token-bearing URL is printed.

### 5. Version derivation lives in one pure function that mirrors the workflow

`computeVersions(latestTag, bump)` reproduces `git describe --tags --abbrev=0` plus the workflow's `awk` arithmetic, including the `v0.0.0` fallback and `v` prefix handling. Unit tests pin patch/minor/major and the no-tag case. The workflow remains the source of truth; the function carries a comment pointing at the workflow's "Calculate next version" step, and the skill tells the maintainer to re-check preflight when `publish.yml` changes. Extracting shared logic is impossible without restructuring the YAML, so the drift risk is documented instead.

### 6. The changelog gate renders, it does not re-implement git-cliff filters

Counting raw `git log` commits would count entries cliff skips (`chore(release)`, `chore(openspec)`), and duplicating `cliff.toml`'s parsers would drift. Instead the gate runs the same render the workflow uses — `git-cliff --unreleased --tag <next>` — parses stdout only (stderr carries INFO/WARN), and requires at least one entry line. The rendered section doubles as the preview the procedure shows before the confirmation gate. `git-cliff` must be on `PATH`; a missing binary fails the gate with the install command as remediation.

### 7. Publishing stays CI-only; the auth gate is about dispatch, not npm

The supported path never runs `npm publish` or pushes tags from the checkout: the workflow publishes with provenance and creates the release. Therefore the credentials gate checks `gh` (needed to dispatch and monitor), and version collisions are caught by the `registry` gate. Local npm login is not a precondition; the recovery matrix names the one break-glass case where local credentials are required, and notes it loses provenance.

### 8. Recovery is a matrix keyed to the furthest completed stage

The skill classifies a failed run by observable state, then applies one of:

| Furthest stage                       | Evidence                                             | Default recovery                                                                                                                                                 |
| ------------------------------------ | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Nothing pushed                       | no `chore(release)` commit on the remote branch      | Fix the cause and dispatch again                                                                                                                                 |
| Release commit pushed, no tag        | remote branch head is the release commit; tag absent | `git revert` the release commit, push, fix, dispatch again — a direct re-dispatch would bump and prepend the changelog twice                                     |
| Tag pushed, version unpublished      | tag exists; `npm view` does not resolve              | Delete the remote and local tag, revert the release commit, push, then dispatch again; break-glass: complete the release from the tag locally (loses provenance) |
| Version published, no GitHub release | `npm view` resolves; `gh release view` fails         | `gh release create` for the published tag with notes from `CHANGELOG.md`; no new version                                                                         |
| Version published and defective      | published                                            | Fix forward with a new patch release                                                                                                                             |

The rule behind the matrix: never dispatch while a tag exists for an unpublished version, and never create a second version for an already-published one.

### 9. Tests: fake command runner for gates, real files for the mirrors

`tests/release-preflight.test.ts` covers version arithmetic, entry counting (empty vs. rendered, stderr ignored), aggregation (any `fail`/`skipped` ⇒ `ready: false`), argument parsing and exit codes, gate classification through the injected runner, and auth redaction. `tests/release-runbook.test.ts` asserts both skill files exist, are byte-identical, and name the preflight command, the workflow dispatch, the confirmation gate, and every recovery stage. No live network, git, or npm is required by the suite.

### 10. No new dependencies, no consumer-visible surface

Everything used is already present: Bun, Zod, git, git-cliff (as the workflow already requires), `gh`, and `npm view`. The script is dev-only — not referenced from `src/`, not added to `package.json` `files` — so the exports map, bin, peers, and `dist/` layout are untouched. README's Development section gains a short releasing pointer; no `docs/*.md` page changes.

## Risks / Trade-offs

- [`publish.yml`'s version arithmetic drifts from `computeVersions`] → single pure function with tests, a comment naming the workflow step, and a skill instruction to re-verify on workflow changes.
- [git-cliff behavior or availability changes] → the gate uses the same rendered command as the workflow and fails with an install remediation; it never re-implements filtering.
- [`npm view` or `git fetch` network flakiness fails a release attempt] → failures carry remediation and re-running is cheap; no state is changed by preflight.
- [`gh auth status` output could leak a token prefix] → the auth gate never echoes command output, only fixed state strings.
- [Preflight passing does not guarantee workflow success] → the skill monitors the run and the recovery matrix covers partial failures.
- [Running `bun run check` inside preflight duplicates the workflow's checks] → accepted: minutes versus a stranded release; `--fast` exists for state-only diagnosis and never reports ready.
- [Skill copies drift] → `tests/release-runbook.test.ts` fails on any byte difference.
- [An agent treats a `--fast` run as a green light] → `--fast` reports `ready: false` and exits non-zero; the skill keys dispatch on a full run with `ready: true` plus explicit user confirmation.

## Migration Plan

Not applicable — no data, config, or artifact migration. Rollback deletes the two skill files, the script, the test files, the `package.json` script entry, and the README pointer; nothing else references them and no release state is affected.

## Open Questions

_None._
