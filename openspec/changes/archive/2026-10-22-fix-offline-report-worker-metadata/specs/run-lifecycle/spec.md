# Spec Delta

## MODIFIED Requirements

### Requirement: Artifact review flows are unaffected

Static HTML artifacts and offline JSON reports SHALL continue to replay a single complete run into an empty state, without run-begin or clearing semantics. A server started against downloaded CI artifacts SHALL present those artifacts until a run actually begins against that server. CLI artifact-directory mode SHALL not clear anything on startup.

#### Scenario: Server opened on downloaded artifacts

- **WHEN** the server starts with a report path pointing at downloaded CI artifacts and no run begins
- **THEN** all artifact results and approvals are presented and nothing is cleared

#### Scenario: Static HTML artifact unchanged

- **WHEN** a CI run writes the self-contained HTML artifact
- **THEN** it contains exactly that run's results as before, with no clearing behavior applied

#### Scenario: Offline JSON reports unchanged

- **WHEN** a CI run writes its offline JSON report
- **THEN** its event payloads replay into the same report state as before this capability
