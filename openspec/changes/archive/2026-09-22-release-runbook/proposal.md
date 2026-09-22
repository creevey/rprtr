# Proposal

## Why

Releases of `@crvy/rprtr` run through `.github/workflows/publish.yml`, a `workflow_dispatch` workflow that derives the next version from the latest git tag, prepends the git-cliff changelog, commits and pushes a release commit plus tag, publishes to npm with provenance, and creates a GitHub release. Nothing outside that YAML describes the procedure: there is no preflight, no written gates, and no recovery guidance for a run that fails partway. Several steps are irreversible, and the workflow is not resumable — it derives the next version from `git describe`, so once the release tag is pushed, a re-dispatch computes the version after it and silently skips the unpublished one. Releasing is therefore tribal knowledge, and an agent asked to "cut a release" has no gates to obey and no way to establish that dispatching is safe. The current checkout makes the point concretely: its `origin/main` tracking ref was one release behind the remote, and only a fresh fetch revealed that `v0.4.1` was already tagged and published.

## What Changes

- `scripts/release-preflight.ts`, run as `bun run release:preflight -- --bump <patch|minor|major>`: one fail-closed command that evaluates every dispatch precondition — git work tree, release branch, tree cleanliness, sync with the remote after a fetch, `bun run check`, at least one changelog entry since the last tag, next tag absent locally and on the remote, next version unpublished on the registry, and GitHub dispatch credentials. Human-readable by default, `--json` for agents; exit code 0 only when every required gate passes; no credential material in output.
- A `release-runbook` agent skill, mirrored at `.opencode/skills/release-runbook/SKILL.md` and `.claude/skills/release-runbook/SKILL.md`: the executable procedure — preflight, changelog preview, bump decision, explicit user confirmation before the irreversible dispatch, `gh workflow run publish.yml`, run monitoring, post-release verification, and a stage-by-stage recovery matrix.
- Publishing stays CI-only: the procedure never runs `npm publish` or pushes tags from the checkout.
- README's Development section gains a short releasing pointer.

## Capabilities

### New Capabilities

- `release-runbook`: the release procedure as a contract — the gate set and fail-closed result of preflight, the confirmation gate before irreversible actions, and recovery that never republishes or skips a version. Without it, a release can only be run by reading the workflow: a partial failure can strand a tagged-but-unpublished version, and nothing prevents a dispatch from a dirty, unsynced, or red tree. No existing capability covers release engineering — `package-surface` defines what the published package contains, not how a version reaches the registry.

### Modified Capabilities

None.

## Impact

- New: `scripts/release-preflight.ts`, `scripts/release-preflight-core.ts`, `tests/release-preflight.test.ts`, `tests/release-runbook.test.ts`, `.opencode/skills/release-runbook/SKILL.md`, `.claude/skills/release-runbook/SKILL.md`.
- Modified: `package.json` (a `release:preflight` script), `README.md` (Development pointer).
- Unchanged: `src/`, the published package surface (exports map, bin, peers, `files`), `.github/workflows/publish.yml`, `cliff.toml`. No `docs/*.md` page is affected.

## Non-goals

- Changing `publish.yml`, `cliff.toml`, or the versioning scheme (latest-tag `git describe` with manual `patch|minor|major`).
- Local or agent-run publishing, local tag pushing, or a `crvy-rprtr release` CLI subcommand.
- Automating the confirmation gate away: dispatching the workflow always requires an explicit user decision.
- Fixing the workflow's non-resumability; the runbook documents recovery around it.
- A CI-status gate beyond `bun run check` — the workflow re-runs checks before any version bump.
