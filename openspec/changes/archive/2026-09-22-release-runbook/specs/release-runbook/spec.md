## Purpose

Defines how a release of `@crvy/rprtr` is prepared, dispatched, verified, and recovered, so that a maintainer or an agent can cut a release only from a known-good repository state and a partial failure never republishes or skips a version.

## ADDED Requirements

### Requirement: Preflight evaluates every dispatch precondition as one fail-closed command

The repository SHALL provide a release preflight that takes a bump type (`patch`, `minor`, or `major`) and evaluates the preconditions for dispatching the release workflow: the checkout is a git work tree, HEAD is on the release branch, the work tree is clean, the branch is in sync with its remote after a fetch, the repository's checks pass, at least one changelog entry exists since the latest release tag, the computed next tag exists neither locally nor on the remote, the computed next version is not already published, and dispatch credentials are available. The preflight SHALL report a status per gate and SHALL exit non-zero, reporting the release as not ready, when any required gate fails or is skipped. A gate that was not evaluated SHALL NOT be reported as passed.

#### Scenario: All gates pass

- **WHEN** the checkout is clean, on the release branch, in sync with the remote, checks pass, unreleased changelog entries exist, the computed next tag and version are unused, and dispatch credentials are available
- **THEN** preflight reports every gate as passed, reports the release as ready, and exits 0

#### Scenario: Dirty work tree

- **WHEN** the work tree has staged, unstaged, or untracked changes
- **THEN** the cleanliness gate fails, preflight reports the release as not ready, and no later gate is reported as passed on its behalf

#### Scenario: Checkout behind or diverged from the remote

- **WHEN** the release branch is behind or has diverged from its remote after a fetch
- **THEN** the sync gate fails with the ahead/behind counts and the release is reported as not ready

#### Scenario: Checks fail

- **WHEN** the repository's check command exits non-zero
- **THEN** the checks gate fails, the failing command is named, and the release is reported as not ready

#### Scenario: Nothing to release

- **WHEN** the changelog for the unreleased range renders no entries
- **THEN** the changelog gate fails and the release is reported as not ready

#### Scenario: Next tag or version already taken

- **WHEN** the computed next tag exists locally or on the remote, or the computed next version is already published to the registry
- **THEN** the corresponding gate fails and the release is reported as not ready

#### Scenario: Missing dispatch credentials

- **WHEN** the GitHub dispatch credential check fails
- **THEN** the credentials gate fails with remediation and the release is reported as not ready

#### Scenario: A skipped gate never counts as ready

- **WHEN** a required gate is explicitly skipped
- **THEN** preflight reports that gate as skipped, reports the release as not ready, and exits non-zero

### Requirement: Preflight reports machine-readable results without credentials

The preflight SHALL support a machine-readable output mode that names every gate, its status, the computed current and next version, and an actionable remediation for each failure. Its output SHALL NOT contain tokens, credentials, or token-bearing URLs.

#### Scenario: JSON result for an agent

- **WHEN** preflight runs in machine-readable mode
- **THEN** it emits a single JSON document with the bump type, current version, next version, a readiness flag, and one entry per gate with a status and, on failure, a remediation

#### Scenario: Credential material stays out of output

- **WHEN** an authentication gate fails or succeeds
- **THEN** the output reports only the authentication state and never the credential or a URL carrying it

### Requirement: Version derivation matches the release workflow

Preflight SHALL derive the next version exactly as the release workflow does: from the latest release tag, with the requested bump applied, falling back to `0.0.0` when no release tag exists.

#### Scenario: Bump from an existing tag

- **WHEN** the latest release tag is `v0.4.1` and the requested bump is `minor`
- **THEN** preflight reports the current version as `0.4.1` and the next version as `0.5.0`

#### Scenario: No release tag yet

- **WHEN** the repository has no release tag and the requested bump is `patch`
- **THEN** preflight reports the next version as `0.0.1`

### Requirement: The procedure is executable by an agent with an explicit confirmation gate

The repository SHALL provide the release procedure as an agent-discoverable skill that runs preflight before any release action, presents the changelog preview and the version decision, and obtains explicit user confirmation before dispatching the release workflow. The procedure SHALL publish only through the release workflow and SHALL NOT publish to the registry or push tags from the checkout. The procedure SHALL be available to each supported agent tooling directory, and the copies SHALL remain identical.

#### Scenario: Preflight failure stops the procedure

- **WHEN** preflight reports the release as not ready
- **THEN** the procedure stops, reports the failing gates with their remediation, and does not dispatch the workflow

#### Scenario: Confirmation before the irreversible step

- **WHEN** preflight reports the release as ready
- **THEN** the procedure presents the current version, the next version, and the changelog preview, and dispatches only after the user explicitly confirms

#### Scenario: Declined confirmation

- **WHEN** the user declines or does not confirm
- **THEN** no workflow dispatch, tag push, or publish occurs

#### Scenario: Success is verified, not assumed

- **WHEN** the release workflow completes
- **THEN** the procedure verifies that the published version resolves in the registry and that the GitHub release exists for the new tag

#### Scenario: Procedure copies stay in sync

- **WHEN** the release procedure is changed
- **THEN** both agent tooling copies carry identical content

### Requirement: Recovery never republishes or skips a version

The procedure SHALL determine the furthest completed release stage after a failure — nothing committed, release commit pushed, release tag pushed, package published, or GitHub release created — and SHALL recover without publishing a version twice or dispatching past a tagged-but-unpublished version.

#### Scenario: Failure before the release commit

- **WHEN** the workflow fails before pushing the release commit
- **THEN** the recovery is to fix the cause and dispatch again

#### Scenario: Failure after the release commit, before the tag

- **WHEN** the workflow fails after pushing the release commit but before the tag is pushed
- **THEN** recovery restores the pre-release state of the branch or completes the release from the existing commit, and never re-dispatches a workflow that would bump and prepend the changelog a second time

#### Scenario: Failure after the tag, before publish

- **WHEN** the workflow fails after pushing the release tag but before the package is published
- **THEN** recovery either completes publication of that tagged version or removes the tag and restores the branch before dispatching again, and never dispatches a bump that computes past the unpublished version

#### Scenario: Failure after publish, before the GitHub release

- **WHEN** the package version is published but the GitHub release is missing
- **THEN** recovery creates the release for the already-published version without dispatching a new version

#### Scenario: Fix forward after publication

- **WHEN** a published version is found to be defective
- **THEN** recovery ships a new patch release rather than attempting to remove or overwrite the published version
