# Tasks

## 1. Preflight core (test-first)

- [x] 1.1 Write failing `tests/release-preflight.test.ts` covering: `computeVersions` for `patch`/`minor`/`major` from `v0.4.1` and the no-tag `v0.0.0` fallback; changelog entry counting (rendered entries → count, empty section → 0, stderr ignored); fail-closed aggregation (any `fail` or `skipped` gate ⇒ `ready: false`); Zod argument parsing (missing and invalid `--bump`, unknown flag, `--json`, `--fast`, `--branch`, `--remote`); gate classification through an injected fake command runner (dirty tree, behind remote, local tag, remote tag, published version, unauthenticated `gh`); and auth redaction (no command output in the auth gate detail). Verify: `cd tests && bun test release-preflight.test.ts` (new cases fail)
- [x] 1.2 Implement the pure core of `scripts/release-preflight.ts`: Zod-parsed options, `computeVersions`, entry counting, the gate model with `pass|fail|skipped`, fail-closed `ready`, table and JSON renderers, and exit codes (`0` ready, `1` not ready, `2` usage). Verify: `cd tests && bun test release-preflight.test.ts` passes, then `bun run typecheck`
- [x] 1.3 Add the `Bun.spawnSync` command runner and the `import.meta.main` CLI for the nine gates in design order (`worktree`, `branch`, `clean`, `sync`, `changelog`, `tag`, `registry`, `auth`, `checks`), with fixed-string auth details and per-gate remediation; `checks` runs only when the earlier gates pass and is reported `skipped` otherwise; `--fast` skips it explicitly. Verify: `bun scripts/release-preflight.ts --bump patch --fast` prints the gate table with `checks: skipped` and exits 1, and `bun scripts/release-preflight.ts --bump nope` exits 2
- [x] 1.4 Add `"release:preflight": "bun scripts/release-preflight.ts"` to `package.json`. Verify: `bun run release:preflight -- --bump patch --fast` runs the script, and `bun run knip` passes

## 2. Agent-executable procedure

- [x] 2.1 Write `.opencode/skills/release-runbook/SKILL.md`: frontmatter whose description scopes the skill to cutting or publishing a release of this package, then the procedure — choose the bump type, run the full preflight, show the changelog preview (`git-cliff --unreleased --tag v<next>`) and version decision, obtain explicit user confirmation, dispatch with `gh workflow run publish.yml -f bump_type=<type>`, monitor the run, verify the published version and GitHub release, apply the recovery matrix from design D8, and a never-do list (no local `npm publish`, no tag pushes, no dispatch without `ready: true` and confirmation). Verify: the file exists and `bunx oxfmt --check .opencode/skills/release-runbook/SKILL.md` passes
- [x] 2.2 Mirror the skill byte-identical to `.claude/skills/release-runbook/SKILL.md`. Verify: `diff -q .opencode/skills/release-runbook/SKILL.md .claude/skills/release-runbook/SKILL.md` prints nothing
- [x] 2.3 Add `tests/release-runbook.test.ts` asserting both copies exist, are byte-identical, and name `bun run release:preflight`, `gh workflow run publish.yml`, the confirmation gate, and every recovery stage. Verify: `cd tests && bun test release-runbook.test.ts`
- [x] 2.4 Dry-run the procedure on this checkout without dispatching: follow the skill through preflight and the preview, stop at the confirmation gate, and confirm the recovery matrix matches `publish.yml`'s actual stages. Verify: the run records the preflight output, no commit, tag, dispatch, or publish occurred, and `git status --porcelain` still matches the pre-run state

## 3. Docs and full gate

- [x] 3.1 Add a short releasing pointer to the Development section of `README.md` (`bun run release:preflight` plus the skill location). Verify: `bunx oxfmt --check README.md` passes and the section reads correctly in context
- [x] 3.2 Run the full gate and strict-validate this change; no browser behavior changed, so `bun run test:playwright` is not required. Verify: `bun run check && openspec validate release-runbook --strict`
