# Design

## Context

See `proposal.md` — Why. Group status is computed entirely in `src/client/helpers/status.ts` and consumed by the initial tree builder (`path.ts`), live updates (`tree-sync.ts`), and recalculations after approvals, removals, and interrupted-run restoration (`suite.ts`). The live UI, offline replay, and static `crvy-rprtr.html` artifact all bundle the same client code, so one aggregation rule covers every surface.

Today `calcStatus` merges two statuses through `statusUpdatesMap`, a regex allowlist that models transitions rather than severity. It is neither commutative nor associative in the cases that matter: `pending` always beats `failed`, while several `running` combinations depend on child order. A group with a failed and a skipped test therefore stays yellow.

## Goals / Non-Goals

**Goals:**

- Make group status deterministic: the same set of descendant statuses always yields the same group status.
- Guarantee that any failed descendant makes every ancestor group `failed`.
- Keep one aggregation helper for every tree-building and recalculation path.
- Cover direct precedence, live-update rollup, nested propagation, and restored-state rollup with focused tests.

**Non-Goals:**

- Changing individual test statuses or the runner-to-report mapping.
- Adding suite status to persisted report data or protocol messages.
- Changing status colours, filters, counts, next-failed navigation, or run controls.
- Reworking the tree hierarchy or the existing `report-tree` behavior.

## Decisions

### D1: Replace the transition allowlist with a total precedence order

Implement a single pure merge function in `src/client/helpers/status.ts` backed by an explicit rank table:

```
failed > running > retrying > pending > approved > success > unknown > (no status)
```

The merge returns the higher-ranked status, or the other operand when one is absent. Because the comparison is a total order, the result is commutative and associative: `reduce(rollupStatus)` and pairwise ancestor updates agree for any child order.

Rename the exported helper to `rollupStatus` so its new contract is explicit, and update the four rollup call sites. The old `statusUpdatesMap` and `calcStatus` transition model are removed.

Alternatives considered:

- **Keep the allowlist and only add `failed` to `pending`'s allowed transitions.** Rejected — `running`/`running`-adjacent combinations remain order-dependent, and the table would still describe transitions rather than the aggregation we actually perform.
- **Make `running` outrank `failed` until the run settles.** Rejected — the story is that failures must be findable; a group with a known failure would remain yellow while unrelated siblings run. The run lifecycle already replaces in-flight statuses as results settle.
- **Give `pending` priority only over `success`/`approved` but let `failed` bypass it.** This is effectively the chosen total order; keeping it as a partial rule would leave the other order-dependent cases unresolved.

### D2: Use the existing helper; no new module

`src/client/helpers/status.ts` already owns status semantics and is imported by every tree path. No new module or dependency is needed. The design keeps the existing client bundle boundary, so the live UI, offline replay, and static artifact cannot drift.

### D3: Keep group status derived

Suite status stays a client-side projection over test statuses. Do not add it to `report.json`, offline JSON events, WebSocket messages, or CLI output. Existing reports gain the corrected rollup on load without migration.

Alternatives considered: persist suite status in the report. Rejected — it would duplicate truth, require a schema version bump, and still need reconciliation after filters and approvals.

### D4: Preserve non-failure semantics

`running` and `retrying` outrank `pending` so a live group shows progress rather than a stale skipped state. `pending` outranks `approved` and `success` to preserve the existing signal that a group is not fully executed. `approved` outranks `success`. These choices keep the change limited to the reported failure masking and remove only order dependence.

## Risks / Trade-offs

- **A group turns red while siblings are still running** → Intended: a known failure is actionable immediately; red is the failure signal reviewers asked for.
- **Groups with a successful and a skipped test remain yellow** → Preserved current semantics; this change only makes failure dominate. If mixed pass/skip needs different semantics later, it is a separate status-design decision.
- **Unused legacy `retrying` status has no custom dot style** → Precedence is defined for completeness; no current reporter emits it. If it becomes active, its visual treatment belongs to a separate change.
- **Several call sites must use the same helper** → Already true today; tasks add tree-sync and restored-state coverage so a future call site that bypasses the helper fails a test.

## Migration Plan

No migration. Derived group statuses are recomputed on page load and during live updates; stored report data is unchanged. Rollback is a normal revert of the client helper and tests.

## Package Surface

No change to the `exports` map, `bin`, peer dependencies, or `dist/` layout. `src/client/helpers/status.ts` is bundled client code, not a public export.
