# screenshot-approval — Delta Spec

## Purpose

Defines how a reviewed screenshot diff is accepted as the new baseline from the rprtr UI, for any reporter provider: the approve actions update the baseline file on disk and mark the test approved, regardless of whether the baseline location is derived server-side (Playwright snapshot resolution) or reported explicitly by the reporter (metadata-carrying providers such as Vitest).

## ADDED Requirements

### Requirement: Single-image approval

The system SHALL support approving one failed image of one test: the server copies the reported actual image onto the located baseline file, records the approval on the test, and the test's status reflects the approval. When the report image carries explicit approval metadata, the server MUST copy the metadata-declared source onto the metadata-declared baseline target; otherwise the server MUST fall back to its provider-specific baseline resolution.

#### Scenario: Metadata-carrying provider approval

- **WHEN** a test reported by a provider that supplies approval metadata is approved from the UI for a given image
- **THEN** the server copies the metadata source file onto the metadata target path and marks the test approved for that image

#### Scenario: Resolver-derived provider approval

- **WHEN** a Playwright-reported test is approved from the UI for a given image
- **THEN** the server resolves the baseline path from the registered snapshot configuration and copies the actual image onto it, exactly as before this capability existed

### Requirement: Approve-all for a test

The system SHALL support approving all failing images of one test in one action. Images without approval capability — no metadata and no resolvable baseline — SHALL be skipped without failing the whole action.

#### Scenario: Mixed approval capability within one test

- **WHEN** approve-all runs on a test where one image has approval metadata and another image has neither metadata nor a resolvable baseline
- **THEN** the metadata image's baseline is updated and the non-approvable image is skipped, with the action still succeeding

### Requirement: First-run baseline approval

For images that have only a baseline (no actual, no diff — first run), approval SHALL be supported: approving marks the test approved without requiring an image copy, since the reported reference already is the baseline.

#### Scenario: Approving a first-run Vitest baseline

- **WHEN** a Vitest first-run image (expected-only) is approved from the UI
- **THEN** the test is marked approved, no file copy is required, and no error is surfaced

### Requirement: Approval metadata provenance in report state

Report state SHALL record, for each image, the approval source and target paths when the reporter supplied them, so the static HTML artifact and offline JSON reports carry the same approval capability as the live server. Report state SHALL still build images from attachment data even when no approval metadata is present.

#### Scenario: Offline report carries approval capability

- **WHEN** an offline/CI run's test-end event includes approval targets for a screenshot
- **THEN** the replayed report state contains the approval source and target on that image, and approving it from the UI against those reports works identically to the live path

#### Scenario: Reporter without approval metadata

- **WHEN** a test-end event carries no approval targets (older reporter or Playwright)
- **THEN** images are built from attachments alone and approval falls back to baseline resolution, with no schema or validation errors

### Requirement: Invalidated approval on new diffs

A test result containing diff images SHALL invalidate any prior approval of that test, regardless of provider.

#### Scenario: New diff after approval

- **WHEN** an approved test re-runs and produces a diff image
- **THEN** the prior approval is cleared and the test is reported as failing again
