# Spec Delta: test-runner

## ADDED Requirements

### Requirement: Live test tree refresh on source changes

While a server session has a seeded run context, the server SHALL keep the discovered `pending` layer of the live report tree current without a manual trigger. It SHALL watch the runner config file and the directories of the tests named by the latest listing, debounce filesystem changes, and re-enumerate through the same collection-only listing that executes no tests. Re-enumeration SHALL reconcile the discovered layer against the new listing: placeholders for tests no longer listed SHALL be removed, newly listed tests SHALL appear as `pending`, and recorded results, approvals, and run state of tests already known SHALL be preserved. The server SHALL NOT mutate the tree while a run is in progress; changes observed during a run SHALL be reconciled after the run settles. Re-enumerations SHALL serialize, so overlapping changes coalesce into one in-flight listing. A failed re-enumeration SHALL leave the tree as it is, log once, and keep watching for later changes. A watcher that cannot start SHALL degrade to startup-only discovery with one log line and SHALL NOT disable the run controls. The server SHALL dispose its watchers and cancel scheduled re-enumerations on shutdown. The CLI SHALL NOT gain flags for this behavior.

#### Scenario: Added tests appear in a running Vitest project

- **WHEN** the server is running in a Vitest project whose tests were discovered at startup and a watched test file gains a new test
- **THEN** after the debounce the new test appears in the live UI under its file with `pending` status, without a run and without restarting the server

#### Scenario: Added tests appear in a running Playwright project

- **WHEN** the server is running in a Playwright project whose tests were discovered at startup and a watched test file gains a new test
- **THEN** after the debounce the new test appears in the live UI under its file with `pending` status, without a run and without restarting the server

#### Scenario: Deleted and renamed tests leave the pending tree

- **WHEN** a listed test without a recorded result is deleted or renamed while the server runs
- **THEN** after the debounce its discovered placeholder is gone from the live UI and no entry remains for the removed identity

#### Scenario: Config edits re-enumerate with the new project shape

- **WHEN** the runner config file changes while the server runs
- **THEN** the server re-enumerates through the same collection-only listing and the pending tree reflects the new configuration and browser labels

#### Scenario: Recorded results and approvals survive refresh

- **WHEN** re-enumeration runs while the tree holds a recorded result with an approval for one test and a `pending` placeholder for another, and the listing still names both
- **THEN** the recorded test keeps its status, result, and approval, the other test stays `pending`, and neither test appears twice

#### Scenario: Changes during a run apply after the run settles

- **WHEN** a watched test file changes while a run is in progress
- **THEN** the run's streamed state is not mutated while it runs, and once the run ends the server reconciles the discovered layer for the identities the run did not cover

#### Scenario: Rapid changes coalesce into one re-enumeration

- **WHEN** several watched files change within the debounce window
- **THEN** the server performs one re-enumeration for that burst and broadcasts one updated tree

#### Scenario: A failed re-enumeration keeps the tree and keeps watching

- **WHEN** a re-enumeration fails (non-zero exit, unparseable output, spawn error, or timeout)
- **THEN** the live tree keeps its current contents, the run controls stay enabled, the server logs one line, and a later change still triggers a re-enumeration

#### Scenario: An unavailable watcher degrades to startup-only discovery

- **WHEN** the platform or runtime cannot watch the configured roots
- **THEN** startup discovery still populates the tree, the run controls stay enabled, and the server logs one line

#### Scenario: Artifact-only writes do not trigger re-enumeration

- **WHEN** files change only under generated artifact locations — snapshot directories, screenshot or report output, or dependency directories
- **THEN** no re-enumeration is scheduled

#### Scenario: Shutdown disposes watchers

- **WHEN** the server closes
- **THEN** its watchers are disposed and later filesystem changes schedule no re-enumeration

#### Scenario: Refreshed placeholders stay out of persisted and static outputs

- **WHEN** refresh adds or removes discovered placeholders and the server then persists its report, serves offline JSON review, or produces the static HTML artifact
- **THEN** those outputs remain derived from actual run events and contain no discovered-but-never-run tests
