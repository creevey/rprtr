## 1. Shared pin decision in `src/rendering.ts`

- [x] 1.1 Write failing tests for `applyGrayscaleFontRendering(env, options)` covering each result variant — `{ pinned: true, path }` and `{ pinned: false, reason }` for `inherit`, `not-linux`, `no-system-config`, `already-pinned` — using the existing `platform` / `exists` / `writeConfig` seams, and asserting the function mutates the passed env only on the pinned branch. Verify: `cd tests && bun test rendering.test.ts` (expect failures)
- [x] 1.2 Implement the function in `src/rendering.ts` on top of `grayscaleFontconfigEnv`, detecting `already-pinned` by comparing `env.FONTCONFIG_FILE` to `rootFontconfigPath()`. Verify: `cd tests && bun test rendering.test.ts`, `bun run typecheck`
- [x] 1.3 Refactor `deterministicLaunchOptions()` to route through the new function so the helper and the reporter cannot diverge, keeping its current signature and return shape. Verify: `cd tests && bun test rendering.test.ts`, `bun run typecheck`

## 2. Reporter option

- [x] 2.1 Write failing tests that the reporter options schema accepts `fontRendering: 'grayscale' | 'inherit'`, defaults to `'grayscale'`, and rejects any other value at reporter init. Verify: `cd tests && bun test schemas.test.ts` (expect failures)
- [x] 2.2 Add the option to the Zod reporter-options schema and the exported option types. Verify: `cd tests && bun test schemas.test.ts`, `bun run typecheck`

## 3. Reporter pins in its constructor

- [x] 3.1 Write failing tests that constructing `CrvyRprtr` pins `FONTCONFIG_FILE` on a supplied env on Linux, leaves it untouched for each skip reason, and logs exactly one line naming the reason on every skip except `already-pinned`. Verify: `cd tests && bun test reporter-font-rendering.test.ts` (expect failures)
- [x] 3.2 Call `applyGrayscaleFontRendering` from the `CrvyRprtr` constructor, behind the new option, with the process env injectable through the existing `ReporterSeams`. Verify: `cd tests && bun test reporter-font-rendering.test.ts`, `bun run typecheck`
- [x] 3.3 Apply the same constructor hook to the Vitest reporter in `src/vitest.ts`, with tests mirroring 3.1. Verify: `cd tests && bun test vitest-reporter.test.ts`, `bun run typecheck`

## 4. `launchOptions.env` detection

- [x] 4.1 Write failing tests that `onBegin` warns once, naming the project, when a resolved config or project sets `use.launchOptions.env` while pinning is active — and does not warn when pinning was skipped or when the config applies the exported helper. Verify: `cd tests && bun test reporter-font-rendering.test.ts` (expect failures)
- [x] 4.2 Implement the detection in `CrvyRprtr.onBegin`, reading the resolved config without mutating it. Verify: `cd tests && bun test reporter-font-rendering.test.ts`, `bun run typecheck`

## 5. End-to-end guard on the Playwright ordering assumption

- [x] 5.1 Add a Playwright integration test that runs a real multi-worker `playwright test` with the reporter configured and asserts every worker observed `FONTCONFIG_FILE` — so a Playwright upgrade that moves reporter construction after the fork fails CI instead of silently un-pinning. Verify: `bun run test:playwright`
- [x] 5.2 Add a Linux-only screenshot equivalence test asserting that the fontconfig pin and `--disable-lcd-text` render the same page byte-identically, skipped on other platforms. Docker run mode is out of reach here — the Playwright job runs inside a container with no daemon — and those two are the only genuinely different mechanisms anyway. Verify: `bun run test:playwright`

## 6. Docs and release

- [x] 6.1 Add the reporter row to the mechanism table in `README.md` (Text antialiasing) and `docs/text-antialiasing-determinism.md`, restate `deterministicLaunchOptions()` as the escape hatch for `launchOptions.env` / `connectOptions`, and note the one-time baseline regeneration. Verify: `bun run format:check`
- [x] 6.2 Note the `webServer` / `globalSetup` env-leak caveat and the `test.use()` detection gap in `docs/text-antialiasing-determinism.md`, and cross-link from `docs/docker-screenshot-determinism.md`. Verify: `bun run format:check`
- [x] 6.3 Full gate: `bun run check` and `bun run test:playwright`
