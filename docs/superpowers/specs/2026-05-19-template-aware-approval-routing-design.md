# Template-Aware Approval Routing Design

**Date:** 2026-05-19
**Topic:** Reuse Playwright-aware snapshot resolution for Approve and Approve All routing in Crvy Rprtr

## Overview

Crvy Rprtr now resolves passed screenshot baselines for display using Playwright-aware snapshot path logic. That resolver supports:

- named screenshots
- duplicate named screenshots
- unnamed screenshots
- custom `snapshotPathTemplate`
- custom `expect.toHaveScreenshot.pathTemplate`
- conservative slash-containing named screenshot handling

However, the server approval routes still write approved baselines using the old default-style hardcoded snapshot target pattern. This means the UI may display one exact baseline target while Approve or Approve All writes to a different file.

This design makes approval routing use the same exact-only resolver semantics as passed-baseline display, so approval and display target the same snapshot path.

## User Story

As a reviewer approving visual changes in Crvy Rprtr, I want Approve and Approve All to write to the exact snapshot path Playwright would use for that image, so the file being updated always matches the baseline path Crvy Rprtr resolved for display.

## Current Gap

Today:

- passed-baseline display is Playwright-aware,
- approval routing is still default-layout oriented.

So these can disagree for:

- custom snapshot templates
- unnamed screenshots
- duplicate named screenshots
- slash-containing named screenshot titles

That inconsistency is the main remaining gap after the baseline-display work.

## Goals

1. Make `Approve` use the same exact-only target resolution as passed-baseline display.
2. Make `Approve All` use the same exact-only target resolution as passed-baseline display.
3. Avoid all fallback-to-old-default behavior in approval routing.
4. Preserve trust: approval should never guess a target when exact resolution is ambiguous.

## Non-Goals

1. Expand approval scope beyond visual screenshot artifacts.
2. Auto-load Playwright config files.
3. Change the core passed-baseline display resolver model.
4. Guess approval targets from lossy UI-facing names alone.

## Approaches Considered

### A. Route-level shared resolver call

Reuse the existing snapshot resolver directly from approval routes.

**Pros**

- one source of truth
- smallest change in behavior model
- aligns display and approval semantics

**Cons**

- approval routes need enough metadata to reconstruct resolver input

### B. Persist fully resolved approval target paths in report state

Resolve snapshot targets earlier and store them for later approval use.

**Pros**

- approval routes become simple

**Cons**

- stale metadata risk
- more state/schema churn
- less flexible if resolver inputs evolve

### C. Add a separate approval-specific resolver path

Reimplement target derivation inside the approval routes.

**Pros**

- isolated approval code

**Cons**

- duplicates logic
- likely to drift from display semantics
- highest long-term risk

## Recommendation

Adopt **Approach A**.

Approval should reuse the same resolver logic as display resolution. The server should build the same resolver input, ask for exact targets, and only write to a snapshot path when one exact target is available.

## Intended Behavior

### `POST /api/approve`

For a single image approval:

1. find the selected test, retry, and image
2. resolve the exact snapshot target using the shared resolver
3. copy `actual` to that resolved target path
4. only mark the image approved after the copy succeeds

### `POST /api/approve-all`

For bulk approval:

1. iterate approvable final-result images
2. resolve each image independently through the shared resolver
3. copy each `actual` image to its exact target path when resolvable
4. track mixed outcomes per image instead of pretending all succeeded uniformly

## Architecture

### Shared approval target resolution

Approval routes should stop hardcoding snapshot targets in `src/server/routes.ts` and instead delegate to a shared target-resolution helper.

A likely structure is:

- `src/server/routes.ts`
  - call a shared helper for approval target resolution
- `src/server/app.ts`
  - provide routes with the same resolver-relevant config the reporter uses:
    - `playwrightSnapshotDir`
    - `playwrightSnapshotPathTemplate`
    - `playwrightToHaveScreenshotPathTemplate`
- optionally a new helper module such as:
  - `src/server/approval-target.ts`
  - or a shared helper exported from the resolver area

### Data flow

1. UI sends approval request.
2. Route finds the test/result/image.
3. Route builds the same resolver input shape used for passed-baseline display.
4. Route resolves the exact target path.
5. Route copies `actual` to that path.
6. Route persists approval state only after successful write.

## Required Metadata

To make approval target resolution match display target resolution, the server must have enough metadata to reproduce the resolver input later.

### Metadata needed

- test file path
- browser/project name
- resolver config options
- image name being approved
- enough information to reconstruct the declaration sequence and occurrence index
- reporter title path or equivalent title-path data for unnamed screenshots

### Main gap

Current UI-facing image names alone are not sufficient for all approval cases, especially:

- unnamed screenshots
- duplicate named screenshots
- approval after merged report-state processing

### Recommended solution

Persist minimal resolver metadata alongside test results or image entries during report-state processing so approval routes can resolve targets deterministically later.

A practical internal shape should include:

- `kind: 'named' | 'unnamed'`
- `declaredName` when present
- `occurrenceIndex`
- reporter title path or equivalent title-path tokens for anonymous naming

This metadata can remain internal to report processing and server behavior; it does not need to become a broad new public API surface.

## Ambiguity Handling

Approval must follow the same exact-only rules as display.

### For single approve

- if one exact target resolves -> copy `actual` there
- if multiple conflicting targets remain -> do not guess
- if no exact target resolves -> return failure

### For bulk approve

- evaluate each image independently
- approve only those with one exact target and successful copy
- report unresolved and failed-copy images explicitly

## Error Handling

### No actual image

- do not approve
- return/report as non-approvable

### Unresolved or ambiguous target

- do not fall back
- return/report as unresolved

### Filesystem copy failure

- keep approval unset for that image
- surface the failure clearly

## Testing Strategy

### Route-level tests

Add focused tests for:

- single approve with custom template path
- single approve for unnamed screenshot
- single approve for duplicate named screenshot
- single approve for slash-containing name where exactly one candidate wins
- single approve failure when ambiguous
- bulk approve mixed-result set:
  - success
  - unresolved
  - no actual
  - copy failure

### State/metadata tests

Add tests proving the approval-required resolver metadata survives report-state processing and is available later from server-side report data.

### Regression coverage

Preserve current approval behavior for default-layout screenshot names.

## Success Criteria

This follow-up is successful if:

1. `Approve` and `Approve All` write to the same exact snapshot target used by display resolution.
2. custom templates work for approval routing.
3. unnamed screenshots work for approval routing.
4. duplicate named screenshots work for approval routing.
5. slash-containing names are resolved conservatively.
6. no old hardcoded path fallback remains in approval routing.
