## Purpose

Defines what installing `@crvy/rprtr` adds to a consumer's dependency tree and how the package behaves when a test runner it supports is not present, so that supporting a second runner never becomes mandatory for consumers of the first.

## ADDED Requirements

### Requirement: Supported test runners are optional peers

Each test runner `@crvy/rprtr` integrates with SHALL be declared as an optional peer dependency. Installing the package SHALL NOT add a runner the consumer did not ask for.

#### Scenario: Playwright-only consumer

- **WHEN** a project whose only test runner is `@playwright/test` installs `@crvy/rprtr`
- **THEN** the install succeeds
- **AND** no Vitest package appears in the resulting dependency tree
- **AND** no unmet-peer error or warning is reported for Vitest

#### Scenario: Vitest-only consumer

- **WHEN** a project whose only test runner is Vitest installs `@crvy/rprtr`
- **THEN** the install succeeds and no Playwright test package is added on the package's behalf

#### Scenario: Install from a local tarball

- **WHEN** the package is installed from a packed tarball by file path, into a project that provides only one of the supported runners
- **THEN** the install completes successfully rather than failing during dependency resolution

### Requirement: A missing runner is reported, not crashed on

Importing a reporter whose runner is not installed SHALL fail with a message naming the missing package and the entry point that needs it, rather than surfacing a raw module-resolution failure.

#### Scenario: Vitest reporter without Vitest

- **WHEN** a consumer imports the Vitest reporter in a project that has no Vitest installed
- **THEN** the failure message names Vitest as the missing peer and the reporter that requires it

#### Scenario: Playwright reporter without Playwright

- **WHEN** a consumer configures the Playwright reporter in a project that has no Playwright test package installed
- **THEN** the failure message names the missing peer and the reporter that requires it

### Requirement: The packaged manifest is verified, not assumed

The published manifest's peer contract SHALL be checked against a real install of the packed artifact, so a dependency added for one runner cannot silently become mandatory for every consumer.

#### Scenario: Packed tarball installed into a single-runner fixture

- **WHEN** the repository's checks run
- **THEN** the packed tarball is installed into a fixture providing exactly one supported runner
- **AND** the check fails if the install errors, or if the other runner appears in the installed tree
