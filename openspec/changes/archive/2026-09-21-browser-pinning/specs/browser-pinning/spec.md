## Purpose

Lets teams declare which browser builds their screenshot baselines belong to, have rprtr verify that every run actually renders with those builds, and see the exact environment behind every result across the live UI, static HTML artifact, offline JSON reports, and CLI.

## ADDED Requirements

### Requirement: Browser pin declaration

A Playwright project SHALL be able to declare a browser pin through its Playwright project `metadata` under the `crvyRprtr` key, shaped as `{ browser, version }`, where `browser` is `chromium`, `firefox`, or `webkit`, and `version` is a version prefix: one or more dot-separated numeric segments (`147`, `147.0`, `147.0.7727.15`). When a project has no pin, a pin declared in the Playwright config root `metadata.crvyRprtr` SHALL apply to it. Pins SHALL be validated when the reporter initializes; an invalid pin SHALL fail initialization with a message naming the project and the offending value. The declared `browser` SHALL match the project's configured browser; a mismatch SHALL be reported as an invalid pin rather than as drift.

#### Scenario: Valid prefix pin accepted

- **WHEN** a project declares `metadata.crvyRprtr = { browser: 'chromium', version: '147' }`
- **THEN** the reporter initializes normally and treats Chromium 147 as the pinned build for that project

#### Scenario: Config-level fallback applies to unpinned projects

- **WHEN** the config root declares `metadata.crvyRprtr` and a project declares no pin of its own
- **THEN** the config-level pin applies to that project

#### Scenario: Project pin overrides config-level pin

- **WHEN** both the config root and a project declare pins
- **THEN** the project-level pin is used for that project

#### Scenario: Invalid pin fails initialization

- **WHEN** a pin has an empty version, a non-numeric segment, a value such as `latest`, or an unknown browser name
- **THEN** reporter initialization fails with a message naming the project and the offending value

#### Scenario: Pin browser conflicts with project browser

- **WHEN** a project runs Firefox but its pin declares `browser: 'chromium'`
- **THEN** reporter initialization reports an invalid pin naming both the configured and declared browsers

### Requirement: Version-prefix matching

Pin matching SHALL be segment-wise: omitted trailing segments match anything, while every provided segment SHALL match exactly. `147` SHALL match `147.0.7727.15`; `147.0` SHALL match `147.0.7727.15`; `147.0.77` SHALL NOT match `147.0.7727.15`. A pin SHALL be considered satisfied when the effective browser build version matches its prefix, and drifted when it does not. Matching SHALL compare the effective build that Playwright resolves on the current platform, not a default or cross-platform build.

#### Scenario: Major-only prefix matches any build of that major

- **WHEN** the pin is `147` and the effective Chromium build is `147.0.7727.15`
- **THEN** the pin is satisfied

#### Scenario: Major-minor prefix matches

- **WHEN** the pin is `147.0` and the effective Chromium build is `147.0.7727.15`
- **THEN** the pin is satisfied

#### Scenario: Partial trailing segment does not match

- **WHEN** the pin is `147.0.77` and the effective Chromium build is `147.0.7727.15`
- **THEN** the pin is treated as drifted

#### Scenario: Prefix does not match a different build

- **WHEN** the pin is `147` and the effective Chromium build is `149.0.7827.55`
- **THEN** the pin is treated as drifted

### Requirement: Run environment resolution

For every pinned project, the reporter SHALL resolve the effective browser build from the installed Playwright's own browser manifest and SHALL record the environment with the run: Playwright version, browser name, browser version, browser revision, and the Docker image when the run executes in Docker mode. Resolution SHALL be offline, SHALL NOT require network access, and SHALL NOT alter test execution.

#### Scenario: Local run records the environment

- **WHEN** a pinned project runs locally with an installed Chromium build
- **THEN** the run carries the Playwright version, browser version, and browser revision alongside the pin status

#### Scenario: Docker run records the image

- **WHEN** a pinned project runs in Docker mode
- **THEN** the recorded environment includes the Docker image used for the run

#### Scenario: Platform override makes the build unverifiable

- **WHEN** the host platform resolves an overridden browser revision that the installed Playwright manifest does not associate with a browser version
- **THEN** the pin status is reported as unverifiable on this platform and is not reported as drift

### Requirement: Unverifiable environments

Projects that do not run Playwright's bundled browsers — for example projects configuring a branded browser channel or an explicit browser executable — SHALL be reported as unverifiable and SHALL NOT be reported as drift, even when a pin is declared, because the reporter cannot observe the launched build. Projects without a pin SHALL be reported as unpinned and SHALL NOT produce drift warnings.

#### Scenario: Channel project is unverifiable

- **WHEN** a pinned project configures a branded browser channel
- **THEN** its pin status is unverifiable and no drift warning is produced

#### Scenario: Unpinned project stays quiet

- **WHEN** a project declares no pin and no config-level pin applies
- **THEN** its status is unpinned and no drift warning is produced

### Requirement: Pin policy and diagnostics

The reporter SHALL accept a `browserPinPolicy` option with values `warn` (default) and `fail`. Under `warn`, drifted pins SHALL be reported without failing tests. Under `fail`, a drift SHALL fail the run with a diagnostic that names the project, the declared pin, the effective browser build, and a concrete remedy (the Playwright version that provides the pinned build, or the matching Docker image tag). Unverifiable and unpinned statuses SHALL never fail a run under either policy.

#### Scenario: Drift under warn policy

- **WHEN** a pin drifts and the policy is `warn`
- **THEN** tests run to completion and the result is annotated as drifted

#### Scenario: Drift under fail policy

- **WHEN** a pin drifts and the policy is `fail`
- **THEN** the run fails with a diagnostic naming the project, pin, effective build, and remedy

#### Scenario: Unverifiable never fails

- **WHEN** a pin is unverifiable and the policy is `fail`
- **THEN** the run completes without a pin failure

### Requirement: Pin status and provenance across output surfaces

Pin status and the recorded environment SHALL be surfaced consistently in the live UI, the static HTML artifact, and offline JSON reports. The live UI SHALL show the pinned project's build and pin status, and SHALL mark drifted tests. The static HTML artifact SHALL carry the same environment and status information and remain browser-openable and self-contained except for screenshot files. Offline JSON reports SHALL include the environment and status fields. Loading artifacts produced without environment data SHALL remain supported; absent fields SHALL be treated as unknown rather than as drift.

#### Scenario: Live UI shows pin status

- **WHEN** a run streams to the UI server
- **THEN** the UI shows the pinned build and status, and drifted tests are visually marked

#### Scenario: Static artifact carries provenance

- **WHEN** a run writes the static HTML artifact
- **THEN** the artifact shows the environment and pin status without any server

#### Scenario: Offline report carries environment

- **WHEN** a run writes offline JSON reports
- **THEN** each report includes the environment fields and pin status for pinned projects

#### Scenario: Legacy artifacts remain loadable

- **WHEN** an artifact produced by an earlier rprtr version without environment data is loaded
- **THEN** it loads successfully and its pin status is shown as unknown

### Requirement: Pin resolution data and CLI

The CLI SHALL provide a `browsers` command group that resolves version prefixes against a Playwright build map: `crvy-rprtr browsers list` lists entries (stable Playwright releases only unless requested otherwise), and `crvy-rprtr browsers resolve <engine>@<prefix>` reports the effective build, its revision, the Playwright version that ships it, the currently installed environment's state, and a remedy when they differ. When a prefix matches several builds, the newest build SHALL be recommended and the alternatives SHALL be listed. Resolution SHALL use a cached build map and SHALL degrade with a clear diagnostic when the map is unavailable offline. Neither the reporter nor its runtime SHALL perform network access for pin validation.

#### Scenario: Resolve a unique prefix

- **WHEN** the user runs `crvy-rprtr browsers resolve chromium@147`
- **THEN** the output names the Chromium build, its revision, and the Playwright version that ships it

#### Scenario: Resolve an ambiguous prefix

- **WHEN** a prefix matches several builds across Playwright releases
- **THEN** the output recommends the newest build and lists the alternative builds with their Playwright versions

#### Scenario: Resolve an unknown prefix

- **WHEN** no build matches the prefix
- **THEN** the command fails with a diagnostic listing the nearest matching browser majors per engine

#### Scenario: Resolution offline

- **WHEN** the build map cannot be fetched and no usable cache exists
- **THEN** the command fails with a clear offline diagnostic and a non-zero exit code

### Requirement: Offline pin check for CI

The CLI SHALL provide `crvy-rprtr browsers check [--strict]`, which evaluates declared project pins against the installed environment without network access. It SHALL report each pinned project's declared pin, effective build, and status; with `--strict` it SHALL exit non-zero when any pin is drifted, and without it SHALL exit zero while still reporting drift. Unverifiable and unpinned projects SHALL never cause a non-zero exit.

#### Scenario: All pins satisfied

- **WHEN** every declared pin is satisfied by the installed environment
- **THEN** `browsers check --strict` exits zero

#### Scenario: Drift detected with strict mode

- **WHEN** a declared pin is drifted and `--strict` is passed
- **THEN** the command reports the drifted projects and exits non-zero

#### Scenario: Drift without strict mode

- **WHEN** a declared pin is drifted and `--strict` is not passed
- **THEN** the command reports the drift and exits zero

#### Scenario: Check works offline

- **WHEN** the command runs without network access
- **THEN** it evaluates pins using only the installed environment and reports results

### Requirement: Docker preflight and validation do not mutate artifacts

Before a Docker run starts, a drift between the declared pin and the environment implied by the installed Playwright version SHALL be reported as a preflight diagnostic with the matching image tag as the remedy, and no container SHALL be started for that run. Pin validation SHALL NOT modify baselines, screenshot files, snapshot path resolution, or approval behavior; drifted results SHALL remain reviewable and approvable under the warn policy.

#### Scenario: Preflight blocks a drifting Docker run

- **WHEN** a Docker run is requested for a project whose pin the installed Playwright version cannot satisfy
- **THEN** the run is rejected before any container starts, with the matching image tag as the suggested remedy

#### Scenario: Validation leaves baselines untouched

- **WHEN** a pin drifts under the warn policy
- **THEN** no baseline or snapshot file is created, modified, or deleted, and approval remains available in the UI
