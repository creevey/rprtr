# vitest-reporter — Delta Spec

## MODIFIED Requirements

### Requirement: Screenshot artifact normalization

The system SHALL convert Vitest `toMatchScreenshot` test artifacts into the rprtr image model: a `reference` artifact maps to the expected image, `actual` and `diff` artifacts map to their roles, grouped per screenshot name derived from the artifact file names. When only a reference exists (first run), the image SHALL surface as baseline-only with no actual or diff image. For a **passing** `toMatchScreenshot` assertion — where Vitest records no artifacts and no error — the reporter SHALL derive the screenshot declaration from the test's source code and report the existing reference as an expected image classified baseline-only, carrying approval metadata for it. A passing screenshot whose reference file is missing on disk MUST be reported as a failed comparison (Vitest's own first-run behavior), not synthesized as passing.

#### Scenario: Failed comparison produces all three roles

- **WHEN** a Vitest screenshot assertion fails with reference, actual, and diff artifacts
- **THEN** the reported test result contains one image entry named after the screenshot with expected, actual, and diff images

#### Scenario: First run with no existing reference

- **WHEN** a Vitest screenshot assertion runs for the first time and vitest records a new reference
- **THEN** the reported image contains only the expected image and is classified as baseline-only

#### Scenario: Passing comparison surfaces the baseline

- **WHEN** a Vitest screenshot assertion passes and the reference file exists on disk
- **THEN** the reported test result contains one image entry named after the screenshot with an expected image (baseline-only) and approval metadata targeting the reference path
- **AND** the test remains visible in the live UI sidebar and in the static HTML artifact after the run completes

#### Scenario: Passing assertion with a missing reference fails honestly

- **WHEN** a Vitest screenshot assertion passes but the expected reference file is absent from disk (e.g. deleted after the run started)
- **THEN** the reported image is not synthesized from source extraction alone; the test is reported without a synthetic expected image and the omission is logged

#### Scenario: Non-visual passing tests stay out of the visual sidebar

- **WHEN** a Vitest test passes without any `toMatchScreenshot` call in its source
- **THEN** the reported result carries no visual names and the UI keeps it hidden per the existing visibility rule

## ADDED Requirements

### Requirement: Vitest screenshot declaration extraction

The Vitest reporter SHALL determine each test's `toMatchScreenshot` screenshot names by extracting them from the test module's source code, replicating Vitest's screenshot-name sanitization and occurrence numbering, so that passing assertions carry the same visual identity failing assertions get from artifacts and error messages. Extraction failures (unreadable file, unparsable call sites) SHALL degrade to the current failure-only behavior without corrupting reported results.

#### Scenario: Named screenshot extracted from source

- **WHEN** a test's source calls `toMatchScreenshot('button-solid')` and the assertion passes
- **THEN** the reported passing result carries the visual name `button-solid` and the reference resolved at the Vitest default layout path for that name

#### Scenario: Repeated names and path-like names follow Vitest conventions

- **WHEN** a test calls `toMatchScreenshot` with the same name twice, or with a path-like name containing `/`
- **THEN** occurrence numbering and the derived reference file name match what Vitest itself writes on disk

#### Scenario: Extraction degradation never breaks reporting

- **WHEN** the test module's source cannot be read or no declaration can be extracted for a passing test
- **THEN** the test is still reported with its correct status, and the reporter logs the extraction gap instead of failing the run
