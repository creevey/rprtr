## Context

See proposal.md — Why. The mechanics that make this possible are already in the codebase; what is missing is a caller.

- `src/fontconfig.ts` generates a root config that includes the system one and forces `rgba=none`, and returns it as a `FONTCONFIG_FILE` value, or `null` on non-Linux / when no system config exists.
- `src/rendering.ts` wraps that into `deterministicLaunchOptions()` for Playwright configs, and `deterministicChromiumLaunchOptions()` (`--disable-lcd-text`) for configs that cannot set browser env.
- `src/server/fontconfig.ts` + `src/server/docker-run-args.ts` mount the drop-in in docker mode; `src/server/run-launcher.ts` exports `FONTCONFIG_FILE` in local mode.

The load-bearing constraint is ordering inside Playwright, verified against `@playwright/test` 1.59.0 and confirmed with a probe reporter across two workers:

| step                                                                             | where                                                                       |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| reporters constructed                                                            | `runner/reporters.js` `createReporters`, called from `runner/testRunner.js` |
| workers forked, with `env: { ...process.env, ...extraEnv }` snapshotted at spawn | `runner/processHost.js`                                                     |
| browser launched, reading `options.env ?? process.env` live                      | `playwright-core/lib/server/browserType.js`                                 |

A reporter constructor therefore runs strictly before any worker exists, and the browser reads the worker's environment at launch — later still. Setting `process.env.FONTCONFIG_FILE` in the constructor is sufficient. Vitest has the same shape: the reporter is constructed before the browser provider starts.

## Goals / Non-Goals

**Goals:**

- One code path that decides "pin or not, and why", shared by the reporter, both run modes, and the exported helpers, so the four can never drift apart.
- A skip that is always explained in one line, because silent no-ops are what made the current gap invisible.
- No behavior change for a consumer already calling `deterministicLaunchOptions()`.

**Non-Goals:**

- Detecting subpixel AA in captured pixels to self-diagnose. Interesting, but it belongs with diff reporting, not with pinning.
- Making the reporter rewrite `launchOptions`. A reporter receives the resolved config read-only; mutating it would be both unsupported and invisible to the consumer.

## Decisions

**Pin from the constructor, not `onBegin`.** Both run before the first fork, but `onBegin` also runs after `globalSetup`, and a `globalSetup` that launches a browser to prime state would miss the pin. The constructor has no such hole. Alternative considered: a Playwright `plugin`, which would be the "proper" hook — rejected because plugins are not part of the reporter contract and would force consumers to add a second config entry, which is exactly the thing this change removes.

**Mutate `process.env` rather than pass env per worker.** A reporter has no channel to a worker's environment; `extraEnv` is Playwright's, keyed by project. The mutation is one variable, is skipped when it cannot apply, and is the same variable local run mode already exports one process out — so the blast radius is a superset of behavior that already ships. Alternative considered: writing the drop-in into `/etc/fonts/conf.d` when writable, as docker mode does — rejected, because a reporter must not modify the machine it runs on.

**Extract `applyGrayscaleFontRendering(env, options)` into `src/rendering.ts`** returning a discriminated result — `{ pinned: true, path }` or `{ pinned: false, reason }` with `reason` one of `inherit`, `not-linux`, `no-system-config`, `already-pinned`. The reporter logs on the `false` branch, the run modes reuse the same reasons, and the spec's skip scenarios map one-to-one onto the variants. This is the "name the existing module" answer: `src/rendering.ts` already owns this concern; no new module.

**Detect `already-pinned` by comparing the current `FONTCONFIG_FILE` against `rootFontconfigPath()`.** `resolveSystemFontconfig` already skips its own file to stay re-entrant, so the value is a reliable marker that an rprtr launcher set it. Avoids a second generated config and a confusing skip log inside docker mode.

**Warn on `launchOptions.env`, per project, once per run.** The reporter can read the resolved config in `onBegin`, so the check lands there, after the constructor already pinned. Warning rather than failing: a consumer may have set `env` for reasons unrelated to fonts and may already be passing their own fontconfig.

**Reuse the option name and values from the run modes** (`fontRendering: 'grayscale' | 'inherit'`) rather than introducing a reporter-specific name, and validate it with Zod so a typo fails at reporter init rather than silently inheriting. There is no existing reporter-options schema to extend — reporter options are plain interfaces read with `?? default`, `browserPinPolicy` included — so this adds a focused `src/schemas/reporter-options.ts` covering the one option rather than retrofitting validation onto the whole surface, which would change how every existing option fails.

## Risks / Trade-offs

- **A consumer's existing baselines were captured with subpixel AA, and this change flips them on upgrade.** → Same one-time regeneration the helper already documents, but it now arrives without the consumer opting in, so it is a minor-version note in CHANGELOG and README, and `fontRendering: 'inherit'` is the one-line revert.
- **`process.env` mutation leaks into `webServer` and `globalSetup` children.** → It is a fontconfig variable pointing at a config that includes the system one; a non-browser child ignores it and a browser child is exactly the target. Acceptable, and called out in the docs.
- **The ordering guarantee is Playwright-internal and could change.** → Covered by an integration test that runs a real multi-worker `playwright test` and asserts the worker saw the variable, so a Playwright upgrade that breaks the assumption fails CI instead of silently un-pinning.
- **`launchOptions.env` detection can miss a `test.use()` set inside a spec file**, which the reporter never sees. → Documented limitation; the pixel diff still surfaces it, and the helper remains the fix.

## Migration Plan

Ships as a minor version. Consumers on `deterministicLaunchOptions()` see no change. Consumers relying on inherited subpixel AA regenerate baselines once or set `fontRendering: 'inherit'`. No data migration; rollback is the option flag.
