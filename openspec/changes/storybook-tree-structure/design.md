# Design

## Context

See `proposal.md` — Why. The sidebar path is currently built independently in three places: `treeifyTests` (initial tree), `pathTokensFor` (live `syncTreeState`), and `getTestPath` (selection/URL). All three prepend `fileTokens` to `titlePath` + `title` + `browser`, which produces `tests/e2e/foo.spec.ts/<describe>/<title>/<project>` for a Storybook test even when the authored path already names the kind and story. The recent discovery work added `fileTokens` to keep discovered and streamed tests in the same slot; that slot identity is separate from the sidebar's display hierarchy.

Spec: `specs/report-tree/spec.md`.

## Goals / Non-Goals

**Goals:**

- Make one path builder authoritative for tree creation, live updates, and selection.
- Render authored Storybook/test paths exactly, with `/` in a `titlePath` segment or `title` expanding into nested rows.
- Keep exactly one synthetic level below the authored path: the project/browser leaf.
- Keep plain Playwright tests from different files distinguishable through the existing file-token fallback.
- Preserve discovery/live/offline/static parity.

**Non-Goals:**

- No report schema, reporter event, or `.openspec` storage change.
- No automatic Storybook story discovery or manual-interaction inference.
- No change to filters, status rollups, run launching, approval routing, or screenshot handling.
- No collapsing of single-child suites; the hierarchy follows authored paths as written.

## Decisions

### D1: One pure shared tree-path module

Extract the display-path rules into a new pure module, `src/report-tree.ts`: `testTreePath(test)`, the authored/file fallback decision, and `findTreePathCollisions(tests)`. The existing `src/client/helpers/path.ts` re-exports/uses it so `treeifyTests`, `pathTokensFor`, and `getTestPath` keep their current imports, while the server can run the same collision detector without importing Svelte-adjacent client code.

Rationale: these three client call sites already duplicate path assembly, which is why the new `fileTokens` rule had to be repeated and could drift. Collision diagnostics also need the exact same path rule on the server, so the rule must live outside the client tree renderer.

Alternative considered: keep the helper in `src/client/helpers/path.ts` and import it from the server. Rejected — the client helper module is the UI layer; server code should not depend on it just to reuse a pure function.

Alternative considered: teach each call site the same rule independently. Rejected — it preserves the current drift hazard and gives no single failing test when one site is missed.

### D2: Authored path first, file fallback second

A test is treated as authored when its `titlePath` is non-empty or its `title` contains `/`. For an authored test the display path is:

```
splitOnSlash(titlePath...) + splitOnSlash(title) + browserLeaf
```

`fileTokens` are ignored. For a non-authored test (empty `titlePath`, no `/` in `title`) the existing fallback applies:

```
fileTokens + [title] + browserLeaf
```

Rationale: Storybook kind paths and story names are the user's navigation model; the spec filename is not. The fallback keeps ordinary Playwright suites (same test name in several files) distinct without reintroducing filesystem levels into story paths.

Alternative considered: always ignore `fileTokens`. Rejected — plain tests with the same title from different files would overwrite each other in the tree.

Alternative considered: add a reporter option such as `treeGrouping: 'story' | 'file'`. Rejected for this change — the authored path is available in every existing report, so no configuration is needed and no new public surface is introduced.

Alternative considered: reorder the existing tokens (`titlePath` before `fileTokens`). Rejected — the filesystem folder/file rows still appear, just in a different position.

### D3: Split authored segments on `/`

`titlePath` entries and `title` are split on `/`, trimmed, and empty segments dropped. This lets a Storybook kind written as a single `describe('Components/Button')`, or a test title written as `Button/Primary`, render as the same nested tree Storybook shows.

Alternative considered: only split when a token looks like a path. Rejected — Storybook's separator is `/`, and a stable, predictable rule is easier to document and test than a heuristic.

### D4: Keep the project leaf

The browser/project leaf remains below the authored path in all cases. It carries the project name, pin badge, per-project run action, and project-specific result selection. Hiding it for single-project runs would make the tree change shape between projects and complicate selection and run controls.

Alternative considered: move the project to a badge on the test row. Rejected — it changes more of the tree component for no requested gain and would still need a level when multiple projects exist.

### D5: Manual interaction tests use their own authored path

Manual interaction tests are ordinary tests in this data model. They appear under their own `titlePath`/`title` when authored, or under the file fallback when not. No story association is inferred. This matches the request that additional levels may be manual interaction tests: authors express that nesting with the same path conventions rather than the UI guessing.

For the Creevey/Storybook shape this is enough to place them beside a story's project leaves. A visual story test is authored as `titlePath: ['Components/Button']`, `title: 'Primary'`; a manual test for that story is authored as `titlePath: ['Components/Button', 'Primary']`, `title: 'opens menu'`. The shared `Primary` node then has two kinds of children: the visual test's project leaf (`chromium`) and the manual test's branch (`opens menu` → project leaf). The children keys differ, so both survive.

Alternative considered: synthesise a "Manual interaction tests" group whenever a story has more than one test. Rejected — it adds a level the user did not ask for and still cannot classify a test as manual without reliable metadata. The authored path already carries the distinction.

### D6: Selection and URL derive from the same path

`getTestPath(test)` returns `testTreePath(test)`. The tree row's path, the selected-test URL, keyboard navigation, next-failed navigation, and `openSuite` therefore agree by construction. Existing `?testPath[...]` URLs generated under the old file-based hierarchy become unresolved and are cleared by the existing missing-test effect; no migration is provided because these URLs are transient review links, not a persisted format.

### D7: Discovery identity remains unchanged

`treeSlotIdentity` in `src/server/report-state.ts` still uses `fileTokens + titlePath + title + browser` to replace a discovered placeholder with its live result. Only the display path changes, so stored `report.json` files and the reporter protocol stay compatible.

### D8: Collisions warn instead of failing

`findTreePathCollisions(tests)` groups tests by `testTreePath(test).join('\0')` and returns groups containing more than one distinct test id. Discovered placeholders are excluded, because a discovered test and its live replacement intentionally occupy the same slot during discovery. The warning names the rendered path and each colliding id/title.

- **Server:** run the detector after loading `report.json`/offline reports and after each test-end. Keep a `Set<string>` of already-reported collision signatures in the handler context so a run does not repeat the same warning on every event.
- **Browser:** run the detector when `src/index.ts` bootstraps from embedded report data and after fetching `/api/report`, so the static artifact and offline replay warn in the browser console too. A page load reports each distinct collision once.
- **Behavior:** warnings never throw, fail a run, drop results, or alter grouping. The UI still uses the existing slot semantics and the second test remains in the report data even if the tree can show only one row per project slot.

Alternative considered: make collisions fail the run. Rejected — a duplicate story id is a report-shape problem, not a test failure, and failing would turn a cosmetic ambiguity into a blocked CI pipeline.

Alternative considered: render a visible warning banner in the sidebar. Deferred — the request asked for a console warning, and a banner needs dismissal/state design that is independent of this hierarchy change.

## Risks / Trade-offs

- **Exact authored path collisions** → A visual test and a manual test coexist when the manual test adds its own title segment (`Primary` → `opens menu`), as Creevey manual tests do. Two tests with the _identical_ authored path and project still share the existing one-slot-per-browser tree shape; the new warning makes that visible with both ids and the shared path. Storybook story ids are expected to be unique, and the fallback keeps plain suites from colliding. If real reports contain identical paths, a follow-up can add a disambiguating leaf without changing the path rule.
- **Slashes in ordinary titles** → A non-story title containing `/` will be split. This is intentional: the slash is the documented Storybook separator; authors who need a literal slash in a single row must avoid that spelling.
- **Old bookmarked URLs** → Selection links recorded before this change no longer resolve. The UI already clears a missing selection; no data loss or run behavior change.
- **Tree mutation drift** → Missing one of the three path call sites would make live updates create a second subtree. Mitigation: all three call the same helper, and a discovery/live parity test covers it.
- **Manual tests without an authored path** → They remain grouped by file, by design. This is the only place a filesystem row can still appear.

## Migration Plan

No migration. `report.json`, offline reports, and the static artifact keep their current schema; existing reports render under the new hierarchy on load. Release as a UI behavior change; document the hierarchy in `README.md` and `examples/component-testing/README.md`.

## Package Surface

No change to `exports`, `bin`, peer dependencies, or `dist/` layout. `src/report-tree.ts` is bundled into the client and server builds but is not a public export.
