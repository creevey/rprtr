# Design: vitest-approval

## Context

See proposal. Today's approval path (server-side): `/api/approve` and `/api/approve-all` resolve the baseline via `resolveBaselineSnapshotPath(approvalRouting, test, retry, image)` — Playwright templates, config captured at register, container-path-aware — then copy the actual image onto it. `applyTestEndEvent` builds images solely from attachments + declarations (report-state.ts). `vitest-browser-reporter` reserved the `approvalTargets` payload field name, unimplemented.

## Goals / Non-Goals

**Goals**

- One approval contract for all providers; Vitest approvals work from the existing UI buttons.
- Playwright approval path byte-identical when metadata is absent.
- Single place builds images; metadata stamping is additive.

**Non-Goals**

- Resolver changes, register-payload changes, docker mapping changes (see proposal).

## Decisions

### D1: Metadata channel = `approvalTargets` on test-end, not precomputed images

`TestEndDataSchema` gains `approvalTargets?: Record<string, string>` (screenshot name → baseline path). The reporter contributes only what it uniquely knows — the reference path. Alternatives rejected: precomputed `images` on test-end (spike's shape) duplicates `attachmentsToImages` in the reporter and forks image-construction logic; provider-branching the snapshot resolver pollutes a Playwright-tuned module and embeds Vitest layout knowledge server-side for no benefit (the reporter already knows the answer).

### D2: Stamping happens in `applyTestEndEvent`, server-side

When `data.approvalTargets` maps a screenshot name that exists in the built images, `applyTestEndEvent` sets `approveFromPath` (the image's actual file — the renamed attachment's native path in dev mode, the content-addressed copy in CI mode; for expected-only first-run images, the expected file) and `approveToPath` on that image. `ImagesSchema` gains both optional fields; they persist into report JSON/static/offline artifacts, which is what makes offline replay approval-capable (spec scenario).

- Alternative: stamp in the server handler layer (`handleTestEnd`) — rejected: report-state is where images are constructed and where offline replay converges; stamping there covers live, replay, and static surfaces with one code path.

### D3: Route resolution order — metadata first, resolver fallback, skip when neither

`/api/approve` and `/api/approve-all` gain a resolution step: image has `approveFromPath` + `approveToPath` → copy those; else `resolveBaselineSnapshotPath(...)` (unchanged Playwright path); neither → skip (approve-all continues; single approve reports not-found as today). The copy for metadata paths is the existing `copyFilePortable` (already used for baseline updates), preserving Windows/docker path handling semantics for any future metadata-carrying container scenario.

### D4: First-run approval = self-copy no-op, not a special case

For expected-only images, stamping sets both source and target to the reference path; the copy is a harmless same-file copy and the test is marked approved. No branching in routes or report-state — the degenerate case falls out of D2/D3 naturally. (Guarded by tests so a future change cannot silently break it.)

### D5: Vitest reporter emits `approvalTargets`

`src/vitest.ts` now fills the reserved field: for each normalized image, the resolved reference path (D4 of `vitest-browser-reporter` — artifact → parsed → reconstructed layers already produce it). Playwright reporter does not emit the field; its absence is the fallback trigger.

## Risks / Trade-offs

- [Metadata paths are reporter-asserted — a buggy/malicious reporter could target arbitrary files for overwrite] → Mitigation: threat model matches the existing model (the reporter already supplies attachment paths the server serves and the resolver copies onto derived paths); metadata paths are validated as absolute existing files before copy; containment-vs-roots check evaluated during implementation and recorded (loosening it for reporter-known baselines is the deliberate trade-off, consistent with `/baseline/` being resolver-trusted).
- [Old offline reports / mixed-version fleets] → all new fields Zod-optional; absence routes to the untouched fallback; no migration.
- [Stamping in report-state changes static/offline artifact bytes for metadata-carrying runs] → additive optional fields only; Playwright runs (no metadata) produce byte-identical artifacts.

## Migration Plan

Additive release; no deploy steps; rollback = revert. Playwright behavior provably unchanged via existing approve-route tests plus the resolver-fallback cases in the new tests.

## Open Questions

- Whether metadata target paths should additionally be constrained to registered artifact roots (D3 risk item) — settled during implementation with the existing `isPathWithinRoots` helper in hand; affects one validation call, not the contract or tasks.
