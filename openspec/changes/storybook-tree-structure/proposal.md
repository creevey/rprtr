# Proposal

## Why

The sidebar currently nests screenshot tests by filesystem location before the authored Storybook kind/story path, so a story such as `Button/Primary` sits under `tests/components/button.spec.ts/Button/Primary/<project>`. Reviewers must expand path levels that carry no Storybook meaning, and the hierarchy does not match the Storybook tree they already use to find a story.

## What Changes

- Build the sidebar hierarchy from a test's authored path (`titlePath` plus `title`) instead of prepending `fileTokens`.
- Split authored path segments on `/` so a Storybook kind such as `Components/Button` becomes `Components` → `Button`, followed by the story title.
- Keep the Playwright/Vitest project leaf (for example `chromium`, `dark`, `mobile`) as the only synthetic level added below a story or test.
- Keep manual interaction tests beneath the story they are authored under (`Primary` → `opens menu` → project) without adding a synthetic manual-test group.
- Fall back to file grouping only for tests with no authored path, so plain Playwright tests in different files do not collide.
- Detect two or more tests that still resolve to the exact same authored path and project, and emit a console warning naming the shared path and the colliding tests instead of silently losing one in the sidebar.
- Apply the same hierarchy to pre-run discovery, live streamed results, offline reports, and the static HTML artifact.
- Use one shared path builder for tree creation, live-tree updates, and the selected-test URL so the three cannot drift apart.

## Capabilities

### New Capabilities

- `report-tree`: Defines the report sidebar hierarchy across live, offline, and static surfaces: authored Storybook/test paths determine grouping, project leaves distinguish projects, and filesystem paths do not appear for tests that carry an authored path.

### Modified Capabilities

None.

## Impact

- `src/client/helpers/path.ts`: shared authored-path/tree-path builder and `getTestPath`.
- `src/client/helpers/tree-sync.ts`: live updates must create and find suites with the same path builder.
- `src/client/components/TreeItem.svelte`: no structural change expected; it renders the hierarchy supplied by the helpers.
- `tests/tree-sync.test.ts`, `tests/path-utils.test.ts` or a new focused helper test: cover Storybook paths, nested kind paths, project leaves, fallback grouping, and discovery/live parity.
- `README.md` and `examples/component-testing/README.md`: document that the sidebar mirrors Storybook story paths rather than spec file paths.
- No package-surface, protocol, or stored-report schema change: `fileTokens` stays in `report.json` for discovery identity and plain-test fallback.

## Non-goals

- Changing how tests are collected, discovered, run, filtered, approved, or reported.
- Changing screenshot validation, snapshot resolution, or artifact naming.
- Inferring manual interaction tests that are not represented by an authored title path.
- Automatically collapsing empty or single-child ancestral nodes beyond the path rule above.
