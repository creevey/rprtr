# Tasks: vitest-approval

All `bun test` commands run inside `tests/` after `bun run build`.

## 1. Schema additions (test-first)

- [x] 1.1 Write failing schema/report-state tests: `TestEndData` accepts optional `approvalTargets` map; replayed offline report with targets stamps `approveFromPath`/`approveToPath` onto the matching image; event without targets builds images as before; old offline report fixtures still parse. Verify: `cd tests && bun test report-state.test.ts offline.test.ts` (new cases fail)
- [x] 1.2 Extend `ImagesSchema` (optional `approveFromPath`/`approveToPath`) and `TestEndDataSchema` (optional `approvalTargets`); implement stamping in `applyTestEndEvent` (metadata present → stamp actual as source, target as target; expected-only image → both = target). Verify: tests from 1.1 pass && `bun run typecheck`

## 2. Route resolution order (test-first)

- [x] 2.1 Write failing approve-route tests: metadata image approved → `copyFilePortable` from metadata source to metadata target (temp-dir file assertions, per existing routes-approve pattern); metadata image in approve-all with a non-approvable sibling → sibling skipped, action succeeds; resolver-fallback case unchanged for Playwright-shaped data. Verify: `cd tests && bun test routes-approve.test.ts` (new cases fail)
- [x] 2.2 Update `/api/approve` and `/api/approve-all` to the metadata-first → resolver-fallback → skip order (D3); validate metadata paths as absolute existing files before copy. Verify: tests from 2.1 pass && `cd tests && bun test artifact-routes.test.ts` (resolver cases still green)

## 3. Vitest reporter emits targets (test-first)

- [ ] 3.1 Write failing `tests/vitest-reporter.test.ts` case: failed comparison event carries `approvalTargets[screenshot] = reference path`; first-run event carries the reference as target; Playwright reporter emits no field. Verify: `cd tests && bun test vitest-reporter.test.ts` (new cases fail)
- [ ] 3.2 Implement `approvalTargets` emission in `src/vitest.ts` (D5). Verify: tests from 3.1 pass && `cd tests && bun test vitest-browser-integration.test.ts` (harness still green)

## 4. End-to-end and gate

- [ ] 4.1 Extend integration assertion: offline report from the real Vitest run carries `approveFromPath`/`approveToPath` on images; approving via the routes against that replayed state updates the fixture reference (temp copy of fixture, never the committed PNG). Verify: `cd tests && bun test vitest-browser-integration.test.ts routes-approve.test.ts`
- [ ] 4.2 README approval section: Vitest approvals supported, first-run baselines approvable. Verify: manual review against spec scenarios
- [ ] 4.3 Full gate + Playwright regression. Verify: `bun run check && bun run test:playwright && cd tests && bun test`
