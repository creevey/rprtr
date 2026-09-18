## Why

crvy-rprtr pins grayscale text antialiasing in the run modes it launches (docker drop-in, local `FONTCONFIG_FILE`), but a project that generates baselines through rprtr and verifies them with plain `npx playwright test` in CI still splits its baselines: the reporter is loaded, yet nothing pins rendering, so the image's own fontconfig decides. `deterministicLaunchOptions()` exists for this, but it is opt-in and undiscoverable — a consumer only learns it exists after the diffs land.

Observed in `keweb.front.components`: baselines generated via rprtr docker mode (grayscale AA), verified by `playwright test` in `playwright:v1.59.0-noble` (subpixel LCD AA). 67 visual tests failed across 4 attempts, every diff confined to glyph edges, expected images carrying zero chroma and actuals up to 136. One of them also shifted a truncation point by a character, so the failure is not purely cosmetic.

## What Changes

- The reporter pins grayscale AA itself: its constructor sets `FONTCONFIG_FILE` on `process.env`, which every Playwright worker forked afterwards inherits, and which the browser each worker launches reads at launch time. Plain `npx playwright test` is covered with no config change.
- The existing `fontRendering: 'grayscale' | 'inherit'` option becomes a reporter option too, with `'grayscale'` the default, matching both run modes.
- Skipped, with a single explanatory log line, when it cannot work or is not wanted: non-Linux, no system fontconfig to include, `fontRendering: 'inherit'`, or a run whose browsers already come from an rprtr-launched environment that pinned it.
- The reporter warns once when it detects a config-level `launchOptions.env`, because that replaces the browser environment wholesale and silently drops the implicit variable — the one case that still needs `deterministicLaunchOptions()`.
- `deterministicLaunchOptions()` and `deterministicChromiumLaunchOptions()` stay exported and documented as the escape hatch; README and `docs/text-antialiasing-determinism.md` gain the reporter row.

## Capabilities

### New Capabilities

- `font-rendering`: pin text antialiasing for a run across every path that produces screenshots — the reporter's own process environment, the two rprtr run modes, and the exported launch-option helpers — and report when pinning was skipped and why. Without it, a reporter-only CI run keeps taking its rendering from the image, which is the failure this change exists to remove; the run modes' existing behavior is folded in so one spec owns the contract.

### Modified Capabilities

- None (no capability specs exist under `openspec/specs/` yet).

## Impact

- Code: `src/reporter.ts` (constructor hook, warning), `src/rendering.ts` (shared apply-to-process helper), `src/fontconfig.ts` (unchanged mechanics, new caller), `src/schemas.ts` / `src/types.ts` (reporter option), `src/vitest.ts` (same hook for the Vitest reporter).
- Published surface: reporter options gain `fontRendering`; `./rendering` exports unchanged; no new dependency.
- Docs: `README.md` (Text antialiasing), `docs/text-antialiasing-determinism.md`, `docs/docker-screenshot-determinism.md`.
- Determinism: consumers whose baselines were captured with subpixel AA regenerate once — same one-time cost the helper already carries.

## Non-goals

- Pinning hinting, font stacks, or DPI — only the `rgba` AA mode, as today.
- Reaching browsers rprtr does not launch locally: `connectOptions`, `launchServer`, or a remote grid never receive local env, and this change does not try.
- Overriding a `launchOptions.env` the consumer set; the reporter warns and leaves it alone.
- Changing `--disable-lcd-text` behavior or dropping either exported helper.
- Auto-regenerating baselines that the new pinning invalidates.
