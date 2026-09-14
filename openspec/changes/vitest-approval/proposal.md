# Proposal: vitest-approval

## Why

Vitest-reported screenshot diffs are viewable after `vitest-browser-reporter`, but approving them from the UI — the product's core loop — only works for Playwright, because the server re-derives baseline paths through Playwright's snapshot templates. Vitest's layout (`__screenshots__/` + `.vitest-attachments/`, no templates) does not fit that resolver. Without this change, a Vitest user can see a wrong screenshot but cannot accept it as the new baseline.

## What Changes

- Test-end payloads MAY carry `approvalTargets` — a map of screenshot name → baseline file path — the single datum the reporter uniquely knows. Reserved by name in `vitest-browser-reporter`; implemented here.
- The server stamps explicit approval metadata (`approveFromPath`/`approveToPath`) onto report images when targets are present; images are still built in exactly one place (server-side, from attachments).
- The approve and approve-all endpoints copy the metadata path when present and fall back to the existing Playwright snapshot-resolver path when not — Playwright approval behavior is unchanged.
- First-run baseline approval for Vitest (reference-only images) approves as a self-copy no-op, marking the test approved.
- Schema additions are Zod-optional: old offline reports and old reporters replay unchanged.

## Capabilities

### New Capabilities

- `screenshot-approval`: the provider-agnostic approval contract — approving one image or all failing images of a test updates the on-disk baseline and marks the test approved, whether the baseline location came from reporter-reported metadata (Vitest) or server-side snapshot resolution (Playwright). No existing capability spec covers approval today (`openspec/specs/` is empty; Playwright approval exists as behavior, not spec). This change creates the contract once, covering both providers, rather than a Vitest-only duplicate.

### Modified Capabilities

_None._

## Impact

- **Code**: `src/schemas.ts` (`TestEndDataSchema.approvalTargets`, `ImagesSchema.approveFromPath`/`approveToPath`); `src/report-state.ts` (metadata stamping in `applyTestEndEvent`); `src/server/routes.ts` (metadata-first copy with resolver fallback); `src/vitest.ts` (emit `approvalTargets` — the reference path per image).
- **Public surface**: no new exports, no wire-format breaking change (additive optional fields); static HTML and offline JSON gain the new optional image fields where targets exist.
- **Docs**: `README.md` approval section notes Vitest support (approve from UI, first-run baselines included).
- **Verification**: `bun test routes-approve.test.ts` (metadata + fallback cases), `bun test report-state.test.ts` (stamping), `bun test vitest-reporter.test.ts` (targets emitted), `bun run check`, `bun run test:playwright`.

## Non-goals

- No changes to `snapshot-path-resolver.ts`, Playwright register payloads, or docker container-path mapping — Playwright keeps resolving baselines exactly as today.
- No new UI affordances — existing Approve / Approve-all buttons drive both providers.
- No approval conflict handling beyond existing behavior (diff invalidates prior approval).
- No un-approve / revert-baseline operations.
