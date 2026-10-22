# Tasks

## 1. Path helper tests and implementation

- [x] 1.1 Add failing tests for a shared test-tree path builder in `tests/tree-sync.test.ts` (or a focused `tests/tree-path.test.ts`): Storybook `Components/Button` + `Primary`, nested describes, a flat `Button/Primary` title, project leaf placement, and `getTestPath` returning the same tokens. Verify the new tests fail against the current file-token-first path.
- [x] 1.2 Implement the shared pure path builder in `src/report-tree.ts`, have `src/client/helpers/path.ts` use it from `getTestPath`, and verify `bun test tree-sync.test.ts` (or the focused path test) passes from inside `tests/`.
- [x] 1.3 Add failing tests for authored-path vs file-fallback behavior: a non-authored test keeps `fileTokens`, an authored test ignores them, and two same-title plain tests from different files stay distinct. Verify the tests fail before the fallback rule is in place.
- [x] 1.4 Implement the authored-path/file-fallback rule and verify `bun test tree-sync.test.ts` plus `bun run typecheck` pass.

## 2. Tree construction and live-sync parity

- [x] 2.1 Update `tests/tree-sync.test.ts` expectations and add a discovery/live parity case: a discovered Storybook test and its streamed replacement resolve to the same authored hierarchy. Verify the parity test fails while `treeifyTests` still prepends `fileTokens`.
- [x] 2.2 Make `treeifyTests` and `pathTokensFor` use the shared path builder from task 1.2, and verify `bun test tree-sync.test.ts` passes.
- [x] 2.3 Add a regression test that `syncTreeState` updates and removes a story test under its authored path without creating a duplicate file-path subtree. Verify it fails before the `pathTokensFor` change and passes after.
- [x] 2.4 Add a regression test for a story visual test plus a manual interaction test authored beneath it (`Components/Button/Primary` + `opens menu`), asserting that `Primary` contains both the visual project leaf and the manual-test branch with its own project leaf. Verify `bun test tree-sync.test.ts` passes.

## 3. Selection and URL parity

- [x] 3.1 Add a test asserting that `getTestPath(test)` for a story test resolves through `getSuiteByPath(treeifyTests(...))` to the same test node. Verify it fails while the tree and URL paths disagree.
- [x] 3.2 Confirm the selection wiring in `src/client/App.svelte` and `src/client/components/TreeItem.svelte` needs no change; verify `bun run typecheck` and a manual check of a story-path URL under the dev UI.

## 4. Collision diagnostics

- [x] 4.1 Add failing tests for `findTreePathCollisions` in a focused test: two tests with the same authored path and project collide, tests with different project leaves do not, normal `Primary` → `opens menu` manual tests do not, and discovered ids are excluded. Verify the tests fail before the detector exists.
- [x] 4.2 Implement `findTreePathCollisions` in `src/report-tree.ts` and verify the focused test plus `bun run typecheck` pass.
- [x] 4.3 Wire the detector into the server: run it after report/offline loading and after `test-end`, dedupe distinct collisions in the handler context, and log a console warning naming the shared path and colliding ids/titles. Verify with a server unit test that the warning is emitted once for a colliding pair and not for a manual-test-under-story pair.
- [x] 4.4 Wire the detector into `src/index.ts` for both embedded bootstrap data and `/api/report`, logging each distinct collision once in the browser console. Verify with a focused unit test for the warning function and `bun run typecheck`.
- [x] 4.5 Confirm a collision warning does not change status, grouping, approval, or run completion; verify the existing server-routes and report-state suites still pass.

## 5. Documentation

- [x] 5.1 Document the hierarchy in `README.md` (Component Testing section) and `examples/component-testing/README.md`: authored Storybook paths drive the sidebar, projects are the only added level, plain tests without an authored path keep file grouping, and exact path collisions are reported as console warnings. Verify `bun run format:check`.

## 6. Full gate

- [x] 6.1 Run the complete gate from the repository root: `bun run check`, plus `bun run example:ct` to confirm the component-testing example still reports and approves. Verify all commands exit 0.
