# Proposal

## Why

A sidebar group containing a failed test and a skipped/pending test currently renders yellow instead of red. The existing aggregation in `src/client/helpers/status.ts` is a status-transition allowlist, not a precedence rule: `pending` always overrides `failed`, and several other combinations depend on child order. Reviewers therefore cannot find the groups that contain failures by colour alone.

## What Changes

- Replace the order-dependent status merge with a deterministic failure-first precedence for sidebar suite/group status.
- A group SHALL show `failed` whenever any descendant test is failed, even if other descendants are skipped/pending, running, approved, successful, or unknown.
- Below `failed`, choose one deterministic order: in-flight (`running`/`retrying`), then `pending`, then `approved`, then `success`, then `unknown`. A group with no status at all stays undefined.
- Apply that order every time suite status is recalculated: initial tree construction, live stream updates and removals, approval recalculation, and restored pre-run state.
- Keep per-test statuses, counts, filters, run lifecycle, report data, and approval behavior unchanged.

The live UI, offline replay, and the static `crvy-rprtr.html` artifact all derive group status through the same client helper, so they SHALL agree without a schema change.

## Capabilities

### New Capabilities

- `report-status-rollup`: Defines how descendant test statuses aggregate into a sidebar group's status across the live UI, offline replay, and the static HTML artifact. Without it, a group with any failure plus a skipped/pending test stays yellow and failure triage remains colour-blind. No existing capability spec covers suite-status aggregation; the implementation currently lives only in `src/client/helpers/status.ts`.

### Modified Capabilities

None.

## Impact

- Code: `src/client/helpers/status.ts` (precedence implementation), with the existing callers in `src/client/helpers/path.ts`, `tree-sync.ts`, and `suite.ts` using the same helper.
- Tests: `tests/status.test.ts`, `tests/tree-sync.test.ts`, and `tests/run-snapshot.test.ts` for direct precedence, live-update parity, and restored-state rollups.
- Docs: `README.md` sidebar section gains one sentence about group status precedence.
- No report schema, offline JSON, WebSocket protocol, CLI, package export, dependency, or screenshot-determinism change.

## Non-goals

- Changing how a single test's status is derived (`passed` → `success`, `failed` → `failed`, `skipped` → `pending`).
- Changing sidebar counts, status filters, status colours/icons, next-failed navigation, or run controls.
- Persisting a suite status in `report.json`, offline JSON reports, or the static artifact; group status remains derived.
- Making `pending`/`skipped` disappear from the tree or changing approval or run semantics.
