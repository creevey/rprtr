# Text Antialiasing Determinism: One Image Is Not Enough

Date: 2026-09-10
Status: verified end-to-end on a consumer project (336 screenshot tests, light set)
Follow-up to: [docker-screenshot-determinism.md](./docker-screenshot-determinism.md)

## Problem

The earlier investigation concluded: use one container image everywhere and the pixels line
up. That holds — as long as **one browser** takes the screenshots. A consumer project that
had already unified on `mcr.microsoft.com/playwright:v1.62.1-noble` kept getting the same
failure signature anyway:

```text
components-MarkdownContent-Default-1: 7842 pixels (ratio 0.03) differ, max channel delta 100
```

Diffs sat on text, everywhere on the page, stable across retries, invisible when the two PNGs
are looked at side by side. Baselines were being repaired one file at a time
(`test(admin): обновили Linux baseline скриншотов`, twice in a week) and kept coming back.

## Evidence

Colored-pixel count (`max(R,G,B) − min(R,G,B) > 8`) over the failing pair:

| image              | colored pixels                                                           |
| ------------------ | ------------------------------------------------------------------------ |
| committed baseline | 300 — the link and the code highlighting, i.e. genuinely colored content |
| CI actual          | 7088 — colored fringes on the edge of every glyph                        |

Grayscale AA against **LCD subpixel AA**. Glyph metrics were untouched: total ink differed by
0.01%, and the row profile showed no shift — hence nothing to see by eye, and a hard fail in
the comparator.

Two more facts pinned it down:

- The pre-fix version of that same baseline (one commit earlier, in Git LFS) is **byte-identical
  to the CI actual**. The file was flip-flopping between two producers, not drifting.
- Running the suite in the very same image locally — amd64 under emulation on an Apple Silicon
  host — reproduced the CI actual **byte for byte**. The image is deterministic; the baseline
  was the outlier.

The second producer was a different Chromium: the project's screenshot config honors
`KISS_PLAYWRIGHT_CHROMIUM_PATH` (an agent-provided system Chromium) whose environment carries
different fontconfig defaults. **Chromium on Linux reads its text AA mode from fontconfig**, so
"same image" only pins rendering while every capture also uses that image's browser.

## Fix: pin the AA mode explicitly

Do not let the environment decide. Grayscale AA can be reached several ways, all verified
**byte-identical** to each other (same sha256 over the rendered PNG, against a different one
for the untouched default) in `mcr.microsoft.com/playwright:v1.59.0-noble`:

| mechanism                                                              | reaches                 |
| ---------------------------------------------------------------------- | ----------------------- |
| Chromium switch `--disable-lcd-text`                                   | Chromium only           |
| fontconfig drop-in in `/etc/fonts/conf.d/`                             | every fontconfig client |
| `FONTCONFIG_FILE` → generated root config that includes the system one | every fontconfig client |
| `FONTCONFIG_PATH` → directory holding that generated config            | every fontconfig client |
| `XDG_CONFIG_HOME` → `fontconfig/conf.d/99-*.conf`                      | every fontconfig client |

A reporter cannot pass browser args, so crvy-rprtr uses the fontconfig routes: the drop-in in
docker mode (the image's own `conf.d` is right there to write into), `FONTCONFIG_FILE` in local
mode (the spawned `playwright test` process exports it and every browser it launches inherits
it). Both land on the same pixels as `--disable-lcd-text`, so a project can mix rprtr-driven
runs and plain `npx playwright test` runs in CI without splitting its baselines again.

### Both run modes, by default

Nothing to configure. To keep the environment's own rendering instead:

```ts
startServer({ fontRendering: 'inherit' }) // or: crvy-rprtr --font-rendering inherit
```

`docker: { fontRendering: 'inherit' }` still works and wins for the docker backend.

The drop-in uses `target="font"`, which is load-bearing: Ubuntu's `10-sub-pixel-rgb.conf` edits
`rgba` at `target="pattern"` with `mode="append"`, and a pattern-level assign does not override
it.

### In a consumer's Playwright config

For runs crvy-rprtr does not launch:

```ts
import { defineConfig } from '@playwright/test'
import { deterministicLaunchOptions } from '@crvy/rprtr/rendering'

export default defineConfig({
  use: { launchOptions: deterministicLaunchOptions() },
})
```

The helper writes the generated root config and merges `FONTCONFIG_FILE` into
`launchOptions.env` (keeping the inherited environment and the caller's own entries), so no
drop-in has to be committed or installed in CI. `deterministicChromiumLaunchOptions()`, which
adds `--disable-lcd-text` instead, stays for configs that cannot set browser env vars — it is
Chromium-only because Firefox exits on unknown command-line flags.

### Firefox and WebKit need nothing

Measured, same image, same page, headless, colored pixels (`max−min > 8`) over a 480×110 text
sample:

| browser  | default | `rgba=rgb` forced at `target="font"` | `antialias=false` forced |
| -------- | ------- | ------------------------------------ | ------------------------ |
| chromium | 4124    | 4124 (already subpixel)              | 0, ink 439824            |
| firefox  | 0       | 0, **byte-identical to default**     | ink 450324 → 463624      |
| webkit   | 0       | 0, **byte-identical to default**     | **byte-identical**       |

So the Playwright builds of Firefox and WebKit never rasterize with subpixel AA: Firefox does
read fontconfig (`antialias` moves its pixels) but not the `rgba` axis, and WebKit ignored
fontconfig here entirely. The earlier note that a multi-browser suite needs its own drop-in in
CI was wrong — only Chromium splits baselines along this axis, and the env route covers it
without a file in the repo.

### Why the generated root config includes the system one

`FONTCONFIG_FILE` **replaces** the root config rather than adding to it. A root config whose
`<include>` does not resolve leaves fontconfig with no font directories at all: the same page
then renders completely blank (total ink 0 against 246192). Hence the include is written with
`ignore_missing="no"`, the included path is `existsSync`-checked before the variable is
exported, and the whole override is skipped when nothing is found — a run with the
environment's own AA beats a run with no fonts. A caller's own `FONTCONFIG_FILE` /
`FONTCONFIG_PATH` is what gets included when present, so their rules survive and ours are
appended after.

Host `FONTCONFIG_FILE` / `FONTCONFIG_PATH` values are also stripped from the docker env for the
same reason: a host path does not exist in the container.

## Consequences, and what it costs

- **Baselines captured with subpixel AA must be regenerated once.** In the consumer project 288
  of 336 files changed; after that, 336/336 passed, and a re-run in the same image was clean.
- Verified that the regeneration was AA-only, not content drift: identical dimensions, no file
  gained colored pixels, and after a Gaussian blur (r = 1.2) the largest channel delta across
  the whole corpus was 36/255. Crops at 4× show the same glyphs in the same places, minus the
  fringes. The darkest pixel of a text run was `31,31,31` before and after — the flag changes
  the AA method, not any color in the page.
- Screenshots stop matching what a Windows/Linux desktop user sees pixel-exactly (macOS has had
  no subpixel AA since Mojave, so nothing changes there). Text reads marginally lighter and
  softer at small sizes. For visual regression this is a fair trade; for pixel-faithful "what
  the user sees" captures it is not.
- The `--disable-lcd-text` switch is Chromium-only; the fontconfig routes are not, and Firefox
  and WebKit need no equivalent anyway (measured above). A multi-browser suite is fully covered.
- Headed runs (`headless: false` under Xvfb) were not measured — the attempt hung under amd64
  emulation. All numbers here are headless, the mode Playwright screenshots use.
- This pins **one** axis. Hinting still comes from the image (`hintstyle`), and that axis moves
  glyph advance widths — the 3px line shift documented in the previous report. Keep using one
  image flavor for that.

## The remaining axis: the browser build itself

Even with one image and one AA mode, the browser binary decides pixel output, and Playwright
upgrades change it silently. Declare which build the baselines belong to and let rprtr check
it on every run:

```ts
metadata: { crvyRprtr: { browser: 'chromium', version: '147' } }
```

`version` is a prefix (`147`, `147.0`, `147.0.7727.15`). The reporter resolves the effective
build offline from the installed Playwright's manifest, records it with the run, and reports
`pinned` / `drift` / `unpinned` / `unverifiable` — branded channels and explicit executables
are `unverifiable`, never drift. `crvy-rprtr browsers check --strict` is the CI gate, and
`crvy-rprtr browsers resolve <engine>@<prefix>` names the Playwright version and Docker image
tag that ship the pinned build. Details and the creevey `browserVersion` migration note:
[Browser Pinning](../README.md#browser-pinning).

## Diagnostic cheat sheet

```bash
# Which AA mode produced a PNG? Count colored pixels; text-only regions give 0 for grayscale
# and hundreds-to-thousands for LCD subpixel.
python3 - "$1" <<'PY'
import sys
from PIL import Image
im = Image.open(sys.argv[1]).convert('RGB'); px = im.load()
w, h = im.size
print(sum(1 for y in range(h) for x in range(w) if max(px[x, y]) - min(px[x, y]) > 8))
PY
```

Compare that number between `-expected` and `-actual` of a failing test: a large gap with
matching layout is this bug, not a UI change.

Do **not** rely on `fc-match -v sans-serif | grep rgba` to confirm the drop-in took effect — its
readout does not reflect a `target="font"` override. Render a page and count colored pixels
instead.
