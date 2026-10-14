# Proposal

## Why

A UI-launched run that dies immediately is nearly undiagnosable from the server terminal: today the only line is `[RunController] test run exited with code 1`, which names neither the execution mode, the command's working directory, the resolved image, nor how long the child lived. When the child's own output is swallowed — a server started by Playwright's `webServer`, a daemon, or an agent pipe — operators cannot even judge whether the command they would run manually is equivalent. `run-output` restored the runner's own terminal output; this change makes rprtr account for the run it launched.

## What Changes

- The server records a compact **launch record** for every UI-launched run before the child spawns: execution mode (local/docker), runner kind, working directory, configuration file, selection size and update flag, and — for docker mode — the resolved image and container name.
- On child exit the server records an **exit record** naming the exit code or terminating signal and the elapsed run duration; a non-zero termination stays visible as a warning.
- Both records are always on: no new flags, environment variables, or `ServerOptions`. They are derived from a launcher-agnostic description of the launch, so local and docker runs read the same and the records survive the docker backend rework.
- Records are terminal-only: no environment values, no command arguments, no changes to `report.json`, offline JSON reports, or the static HTML artifact.

## Capabilities

### Modified Capabilities

- `run-output`: adds a requirement that every UI-launched run records, on the server terminal, what was launched — mode, runner, cwd, config, selection, image/container for docker — and how it ended — exit code or signal and duration. `run-output` currently covers only the runner's own forwarded output; it is the capability that owns terminal diagnosability of a run, so launch/exit records extend it rather than starting a second capability about the same terminal.

## Non-goals

- The full launch vector (arguments, environment names, mount existence checks), child output capture, and container retention — a later debug-mode change.
- Preserving failed containers or changing `--rm`/force-remove behavior in this step.
- New activation surface: no `--debug` flag, no `CRVY_RPRTR_DEBUG`, no `ServerOptions` field.
- Discovery/listing diagnostics and sidecar readiness evidence.
- Any live UI, static artifact, or offline report change.

## Impact

- Code: `src/server/run-controller.ts` (records around spawn and exit), `src/server/run-launcher.ts` (launch-description seam), `src/server/run-process.ts` (exit signal passthrough), `src/server/server-factories.ts` wiring.
- Docs: none required; the records are self-describing terminal output.
- Published surface: no new exports, flags, or peer dependencies.
