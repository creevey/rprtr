# Tasks

## 1. Launch record

- [x] 1.1 Write failing tests in `tests/run-controller.test.ts`: an injected `log` sink receives a launch record on `start()` naming mode, runner kind, cwd, configuration file, selection size, and update flag for both Playwright and Vitest contexts; a docker `LaunchSpec` carrying container info renders the image and container name; a sentinel environment value and a distinctive argument never appear in the record. Verify: `bun run build && cd tests && bun test run-controller.test.ts` (new cases fail).
- [x] 1.2 Add the optional `container?: { image: string; name: string }` field to `LaunchSpec` (`src/server/run-launcher.ts`) and fill it in the docker launcher's `launch()` (`src/server/docker-launcher.ts`); keep local launches unchanged. Verify: `bun run typecheck && cd tests && bun test run-launcher.test.ts docker-launcher.test.ts`.
- [x] 1.3 Emit the launch record from `RunController.start` through a new optional `log` dependency (default `console.log`), before the child spawns, without changing spawn behavior or any broadcast. Verify: task 1.1 tests pass; `cd tests && bun test run-controller.test.ts run-launcher.test.ts docker-launcher.test.ts`.

## 2. Exit record

- [ ] 2.1 Write failing tests in `tests/run-controller.test.ts`: a code-0 exit reaches the `log` sink with the elapsed duration; a non-zero exit reaches `warn` naming the code and duration while preserving the existing `test run exited with code <n>` wording; a signal termination reaches `warn` naming the signal; duration is driven by an injected `now` seam. Verify: `bun run build && cd tests && bun test run-controller.test.ts` (new cases fail).
- [ ] 2.2 Extend the `ChildProcessLike` `exit` callback to carry an optional signal, forward Node's real signal in `createRealSpawn()` (`src/server/run-process.ts`), add the optional `now` dependency, and implement both exit-record branches in `handleChildExit`. Verify: task 2.1 tests pass; `cd tests && bun test run-controller.test.ts run-process.test.ts` (or the covering suite for `run-process`).

## 3. Invariants and gate

- [ ] 3.1 Assert the artifact and live-UI invariants at unit level: records never contain environment values or arguments, and `RunController.start`/`handleChildExit` emit no additional WebSocket broadcasts beyond the existing `run-status` messages. Verify: `cd tests && bun test run-controller.test.ts server-routes.test.ts vitest-discovery-app.test.ts`.
- [ ] 3.2 Full gate: run `bun run check` and confirm no docs page documents server terminal records, so no `README.md` or `docs/*.md` update is required by this change. Verify: `bun run check` exits 0.
