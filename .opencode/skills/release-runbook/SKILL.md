---
name: release-runbook
description: Cut and publish a release of @crvy/rprtr. Use when the user asks to release, cut or publish a version, or dispatch the publish workflow.
---

# Release runbook

Executes a release of `@crvy/rprtr` end to end. The release itself always runs in CI
(`.github/workflows/publish.yml`, `workflow_dispatch` with a `bump_type` input); this procedure
prepares it, gates it, dispatches it, and verifies it. Never publish from the checkout.

## Preconditions

- The repository checkout is on the release branch (`main`) at the release commit.
- `git`, `git-cliff`, `gh` (authenticated), `npm`, and `bun` are on `PATH`.
- Publishing is CI-only: no local npm credentials are needed or used.

## Step 1 — Choose the bump type

Review what shipped since the last release and pick `patch`, `minor`, or `major`:

```bash
git log --oneline "$(git describe --tags --abbrev=0)"..HEAD
bun run changelog:preview
```

A breaking change means `major`, a new feature means `minor`, fixes only mean `patch`. Do not
guess: if the range mixes concerns, ask the user which bump they want before continuing.

## Step 2 — Run the full preflight

```bash
bun run release:preflight -- --bump <type>
```

Every gate must report `pass` and the summary must say `READY`. If it says `NOT READY`, stop,
report the failing gates with their remediation, and do not dispatch. `--fast` skips only the
`bun run check` gate for diagnosis and always reports not ready — it is never a green light. Add
`--json` for machine-readable output.

## Step 3 — Show the release plan

Use the next tag from the preflight output and render the exact changelog section the workflow
will prepend:

```bash
git-cliff --unreleased --tag v<next>
```

Present the current version, the next version, the bump type, and the rendered entries.

## Step 4 — Confirmation gate (required)

Ask the user explicitly whether to dispatch this release. Do not proceed on silence, ambiguity,
or an approval from an earlier message: only an explicit confirmation for this version authorizes
the dispatch. If the user declines, stop — nothing is dispatched, tagged, or published.

## Step 5 — Dispatch

```bash
gh workflow run publish.yml -f bump_type=<type>
```

## Step 6 — Monitor

```bash
gh run list --workflow publish.yml --limit 1
gh run watch <run-id>
```

## Step 7 — Verify, do not assume

```bash
npm view @crvy/rprtr@<next> version    # must print <next>
gh release view v<next>                # must exist with the changelog notes
```

If either check fails, classify the failure with the recovery matrix before doing anything else.

## Recovery matrix

Find the furthest completed stage, then apply the matching recovery. The rule behind the matrix:
never dispatch while a tag exists for an unpublished version, and never create a second version
for an already-published one.

| Furthest stage                       | Evidence                                                                   | Recovery                                                                                                                                                                                                        |
| ------------------------------------ | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Nothing pushed                       | no `chore(release)` commit on the remote branch                            | Fix the cause and dispatch again.                                                                                                                                                                               |
| Release commit pushed, no tag        | remote branch head is `chore(release): bump to v<next>`; the tag is absent | `git revert <release-commit>`, push, fix the cause, then dispatch again. Never re-dispatch on top of the release commit: the workflow would bump and prepend the changelog a second time.                       |
| Tag pushed, version unpublished      | the tag exists; `npm view @crvy/rprtr@<next> version` fails                | Delete the remote and local tag, revert the release commit, push, then dispatch again. Break-glass only: complete the release from the tag with local npm credentials — that loses provenance.                  |
| Version published, no GitHub release | `npm view` resolves; `gh release view v<next>` fails                       | Create the release for the already-published version: extract its section from `CHANGELOG.md` and run `gh release create v<next> --title "Release v<next>" --notes-file <file>`. Do not dispatch a new version. |
| Version published and defective      | the version is published and faulty                                        | Ship a new patch release. Never unpublish or overwrite a published version.                                                                                                                                     |

## Never do

- Never run `npm publish` from the checkout — the workflow publishes with provenance.
- Never `git push` a release commit or tag by hand.
- Never dispatch without `READY` from a full preflight run and explicit user confirmation.
- Never re-dispatch a failed run without classifying its furthest completed stage.
- Never delete or rewrite a tag for an already-published version.

## Maintenance

`computeVersions` in `scripts/release-preflight-core.ts` mirrors the "Calculate next version" step
of `publish.yml`. When the workflow changes that step, update the function and its tests in the
same commit.
