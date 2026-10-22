# Spec Delta

## Purpose

Defines how the report sidebar groups tests into a navigable hierarchy that mirrors authored Storybook/test paths instead of spec file locations, on the live server UI, offline reports, and the static HTML artifact.

## ADDED Requirements

### Requirement: Authored paths determine the sidebar hierarchy

The report UI SHALL build each test's sidebar hierarchy from its authored path — `titlePath` followed by `title` — rather than from its filesystem tokens. Each authored segment SHALL be split on `/` so that a Storybook kind such as `Components/Button` renders as `Components` → `Button`. When a test has a non-empty `titlePath`, or its `title` contains `/`, its `fileTokens` SHALL NOT contribute any sidebar level.

#### Scenario: Storybook kind path is honored

- **WHEN** a test has `titlePath: ['Components/Button']`, `title: 'Primary'`, and `fileTokens: ['tests', 'components', 'button.spec.ts']`
- **THEN** the sidebar shows `Components` → `Button` → `Primary` and does not show `tests`, `components`, or `button.spec.ts`

#### Scenario: Nested authored path

- **WHEN** a test has a `titlePath` with multiple describe levels
- **THEN** those levels appear in their authored order beneath their parent, with no filesystem path inserted between them

#### Scenario: Flat authored title with a separator

- **WHEN** a test has no `titlePath` and a `title` such as `Button/Primary`
- **THEN** the sidebar shows `Button` → `Primary`

### Requirement: Only projects are added below an authored path

The report UI SHALL add exactly one synthetic level below a test's authored path: the Playwright or Vitest project leaf that identifies the execution environment (for example `chromium`, `dark`, or `mobile`). It SHALL NOT add filesystem folders, spec filenames, or other synthetic levels beneath an authored story or test path.

#### Scenario: Project leaves distinguish viewports and themes

- **WHEN** the same story runs under projects `dark` and `mobile`
- **THEN** the story appears once in the hierarchy with `dark` and `mobile` project leaves beneath it

#### Scenario: Single project

- **WHEN** an authored story runs under one project
- **THEN** the story still exposes that project as its only additional level

#### Scenario: Manual interaction test beneath a story

- **WHEN** a story `Components/Button/Primary` has a visual test and a manual interaction test authored beneath it as `Components/Button/Primary/opens menu`
- **THEN** the sidebar shows the visual test's project leaf and the `opens menu` manual-test branch together beneath `Primary`
- **AND** the manual test's project leaf appears beneath `opens menu`

### Requirement: Colliding authored paths are reported

When two or more distinct tests resolve to the exact same authored path and project, the system SHALL emit a console warning that names the shared sidebar path and the colliding test identities. The warning SHALL NOT change the rendered grouping, fail the run, reject an approval, or alter the report. The live server SHALL emit the warning on its terminal; the static HTML and offline replay UI SHALL emit it in the browser console. A distinct collision group SHALL be warned about at most once per server session or page load rather than on every event.

#### Scenario: Live server reports a collision

- **WHEN** two live tests have the same title path, title, and project
- **THEN** the server terminal logs a warning naming the shared path and both tests
- **AND** the run continues and both results are still recorded

#### Scenario: Static artifact reports a collision

- **WHEN** a static or offline report containing the same collision is opened in a browser
- **THEN** the browser console logs the same warning shape
- **AND** the artifact otherwise renders unchanged

#### Scenario: Normal manual test does not warn

- **WHEN** a manual interaction test sits beneath a story through an extra authored segment, as in `Primary` → `opens menu`
- **THEN** no collision warning is produced

### Requirement: Tests without an authored path keep file grouping

A test with no authored path — an empty `titlePath` and a `title` without `/` — SHALL be grouped by its filesystem tokens so that plain Playwright tests sharing a title across different files remain distinct. Tests with an authored path SHALL NOT gain file grouping through this fallback.

#### Scenario: Plain tests from different files do not collide

- **WHEN** two tests have the same title and browser but different `fileTokens`, and neither has an authored path
- **THEN** each test is grouped under its own file path and both remain selectable

#### Scenario: Authored tests ignore the fallback

- **WHEN** a test has a non-empty `titlePath`
- **THEN** its `fileTokens` are not added as sidebar levels even if another test in the report uses the file-grouping fallback

### Requirement: Hierarchy is identical across report surfaces

Pre-run discovered tests, live streamed results, replayed offline reports, and the static HTML artifact SHALL use the same authored-path hierarchy for the same test identity. A test SHALL NOT move between filesystem and authored grouping when a run starts, when results are refreshed, or when an offline report is replayed.

#### Scenario: Discovery is replaced without moving the test

- **WHEN** a discovered Storybook test is replaced by its live streamed result with the same title path, title, and project
- **THEN** the test remains at the same authored hierarchy position before and after the run

#### Scenario: Static artifact matches the live tree

- **WHEN** the same report data is rendered from the live server and from the static `crvy-rprtr.html` artifact
- **THEN** both show the same authored-path grouping and project leaves

### Requirement: Navigation uses the same hierarchy

Selecting a test through the tree, a selected-test URL, keyboard navigation, or next-failed navigation SHALL resolve through the same authored-path hierarchy that renders the tree, so that every visible test can be opened and tracked by its URL.

#### Scenario: Opening a nested story test

- **WHEN** a user opens `Components` → `Button` → `Primary` → `dark`
- **THEN** the selected test's URL and highlighted row refer to that exact authored path and project leaf

#### Scenario: Next-failed stays within the rendered hierarchy

- **WHEN** next-failed navigation moves to a test shown under an authored story path
- **THEN** the destination row and result view correspond to the same tree node
