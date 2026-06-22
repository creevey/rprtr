# Run Specific Tests From UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-test and per-suite run buttons to the sidebar tree so users can run a single test or a branch without leaving the browser tab.

**Architecture:** Each `TreeItem` gains a hover-revealed run button (▶) that appears when `runEnabled && !isRunning`. Clicking it calls a new `onRun(filters)` callback that flows through `Sidebar` → `App.handleStart(filters)`. `handleStart` already sends `POST /api/run` — this plan extends it to accept `{ files?: string[], project?: string }` filters instead of always sending `{}`. For tests, the filter is a single `file:line` from `test.location`. For suites, the filter is the collected `file:line` of every descendant test. The backend (`RunController`, `RunRequestBodySchema`, `/api/run`) already supports filtered runs — no server changes needed.

**Tech Stack:** TypeScript, Svelte 5, existing zod schemas.

**Spec:** This plan follows directly from the Non-Goal acknowledgment in `docs/superpowers/specs/2026-06-19-run-tests-from-ui-design.md:38`: "Per-test rerun this test buttons in the tree. Deferred to a follow-up; the server endpoint accepts `files` so a follow-up can add the UI without API changes."

---

## Design Decisions

### D1: Hover-revealed button per tree item

A small ▶ button appears on hover at the right edge of each tree row (test or suite). Rationale:

- Does not clutter the tree at rest — button is invisible until the user hovers.
- Covers both per-test and per-suite in one consistent pattern.
- No context menus, no extra modes, no checkbox-based selection round-trip.

### D2: `file:line` as the only filter mechanism

Playwright's `test.id` is regenerated per invocation (spec Background, verified facts). The stable per-test filter is `file:line`, which Playwright accepts as a positional argument. Each test carries `location: { file, line }` from `onTestBegin` (`src/reporter.ts:171`). For suites, we collect all descendant test locations and pass them as positional args.

**Limitation acknowledged:** passing many `file:line` args for a large suite could exceed the OS command-line length limit (~256 KB on macOS). This is acceptable for v1; suites with hundreds of test files are rare in practice. A future optimization could deduplicate by file and pass only the minimum line per file.

### D3: `handleStart` accepts optional filters

The existing `handleStart(): Promise<void>` sends `JSON.stringify({})`. This plan extends it to `handleStart(filters?: RunFilters): Promise<void>` where `RunFilters = { files?: string[]; project?: string }`. The global Start button calls `handleStart()` (no args → run all). Tree-item run buttons call `handleStart({ files: [...] })`.

---

## File Structure

**Modify:**

- `src/client/App.svelte` — extend `handleStart` to accept optional `RunFilters`; add `handleRunItem` that builds filters from a test or suite; pass `onRun` + `runEnabled` down to `Sidebar`.
- `src/client/components/Sidebar.svelte` — accept `onRun` callback; pass it + `runEnabled`/`isRunning` down to `TreeItem`.
- `src/client/components/TreeItem.svelte` — accept `onRun` callback + `runEnabled`/`isRunning` props; render a hover-revealed ▶ button that calls `onRun` with the item.

**No new files. No server changes. No schema changes.**

---

## Task 1: Extend `handleStart` to accept optional filters in `App.svelte`

**Files:**

- Modify: `src/client/App.svelte`

- [ ] **Step 1: Import `RunFilters` type**

Add to the imports from `../types` or define inline. The `RunFilters` shape `{ files?: string[]; project?: string }` matches the server's `RunRequestBodySchema`. Since the client doesn't import server schemas, define a local type alias:

At the top of `App.svelte`, after the existing type imports, add:

```ts
interface RunFilters {
  files?: string[]
  project?: string
}
```

- [ ] **Step 2: Change `handleStart` signature and body**

Find `handleStart` (around line 283). Replace it with:

```ts
async function handleStart(filters?: RunFilters): Promise<void> {
  const res = await fetch('/api/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(filters ?? {}),
  })
  if (res.status === 409) {
    const body = (await res.json().catch(() => null)) as { reason?: string } | null
    runMessage =
      body?.reason === 'already-running'
        ? 'A run is already in progress'
        : 'Connect a Playwright reporter to enable running'
  }
}
```

The only change is the `filters?: RunFilters` parameter and `filters ?? {}` in the body. The global Start button still calls `handleStart()` with no args.

- [ ] **Step 3: Add `handleRunItem` helper**

After `handleStart`, add:

```ts
function handleRunItem(item: CrvyRprtrSuite | CrvyRprtrTest): void {
  if (isTest(item)) {
    const file = item.location?.file
    const line = item.location?.line
    if (file !== undefined && line !== undefined) {
      handleStart({ files: [`${file}:${line}`] })
    }
    return
  }
  const locations = getAllTests(item)
    .map((t) => {
      const file = t.location?.file
      const line = t.location?.line
      return file !== undefined && line !== undefined ? `${file}:${line}` : null
    })
    .filter((loc): loc is string => loc !== null)
  if (locations.length > 0) {
    handleStart({ files: locations })
  }
}
```

This reuses the existing `getAllTests` helper (already defined at `App.svelte:261`). For tests, it builds a single `file:line`. For suites, it collects all descendant test locations.

- [ ] **Step 4: Pass `onRun` to Sidebar**

Find the `<Sidebar ... />` invocation (around line 388). Add `onRun`:

```svelte
  <Sidebar
    {tests}
    selectedId={openedTest?.id}
    {focusedPath}
    {isReport}
    {isRunning}
    {isUpdateMode}
    {approvalEnabled}
    {approvalMessage}
    {runEnabled}
    {runMessage}
    {filter}
    {canApprove}
    onFilterChange={(f) => filter = f}
    onSelect={handleOpenTest}
    onOpen={handleSuiteOpen}
    onToggle={handleSuiteToggle}
    onStart={handleStart}
    onStop={handleStop}
    onRun={handleRunItem}
    onApprove={handleApproveAndGoNext}
    onNext={handleGoToNextFailed}
    onApproveAll={handleApproveAllTests}
  />
```

- [ ] **Step 5: Run typecheck**

Run: `bun run typecheck`
Expected: May fail because `Sidebar` doesn't accept `onRun` yet — that lands in Task 2. Defer green typecheck until Task 2 Step 3.

---

## Task 2: Thread `onRun`, `runEnabled`, `isRunning` through `Sidebar` to `TreeItem`

**Files:**

- Modify: `src/client/components/Sidebar.svelte`
- Modify: `src/client/components/TreeItem.svelte`

- [ ] **Step 1: Add `onRun` to Sidebar `Props` and pass-through to `TreeItem`**

In `Sidebar.svelte`, add to the `Props` interface:

```ts
onRun: (item: CrvyRprtrSuite | CrvyRprtrTest) => void
```

Destructure `onRun` in the `$props()` call.

In the `<TreeItem>` instantiation (around line 157), add `onRun`, `runEnabled`, `isRunning`:

```svelte
      <TreeItem
        item={child as CrvyRprtrSuite | CrvyRprtrTest}
        level={0}
        {selectedId}
        {focusedPath}
        {isUpdateMode}
        {runEnabled}
        {isRunning}
        {onSelect}
        {onOpen}
        {onToggle}
        {onRun}
      />
```

- [ ] **Step 2: Add `onRun`, `runEnabled`, `isRunning` to `TreeItem` `Props`**

In `TreeItem.svelte`, extend `Props`:

```ts
interface Props {
  item: CrvyRprtrSuite | CrvyRprtrTest
  level: number
  selectedId?: string
  focusedPath: string[] | null
  isUpdateMode: boolean
  runEnabled: boolean
  isRunning: boolean
  onSelect: (test: CrvyRprtrTest) => void
  onOpen: (path: string[], opened: boolean) => void
  onToggle: (path: string[], checked: boolean) => void
  onRun: (item: CrvyRprtrSuite | CrvyRprtrTest) => void
}
```

Destructure the new props:

```ts
let {
  item,
  level,
  selectedId,
  focusedPath,
  isUpdateMode,
  runEnabled,
  isRunning,
  onSelect,
  onOpen,
  onToggle,
  onRun,
}: Props = $props()
```

Pass them through to recursive `<TreeItem>` calls:

```svelte
    <TreeItem
      item={child as CrvyRprtrSuite | CrvyRprtrTest}
      level={level + 1}
      {selectedId}
      {focusedPath}
      {isUpdateMode}
      {runEnabled}
      {isRunning}
      {onSelect}
      {onOpen}
      {onToggle}
      {onRun}
    />
```

- [ ] **Step 3: Run typecheck**

Run: `bun run typecheck`
Expected: PASS.

---

## Task 3: Render the hover-revealed run button in `TreeItem`

**Files:**

- Modify: `src/client/components/TreeItem.svelte`

- [ ] **Step 1: Add the run button to the tree row**

In `TreeItem.svelte`, add the button inside the main `<div>` row, after the status dot and before the closing `</div>`. The button is positioned at the right edge and revealed on hover via a `group` + `group-hover:opacity-100` pattern.

Add `group` to the row div's class list. Then add the button:

```svelte
<div
  bind:this={rowEl}
  class={cn(
    'group flex items-center py-1 cursor-pointer transition-colors select-none gap-1 hover:bg-surface-hover',
    isSelected && 'bg-surface-selected',
    isFocused && 'outline outline-1 outline-accent -outline-offset-1',
  )}
  style:padding-left="{16 + level * 16}px"
  style:padding-right="16px"
  onclick={handleClick}
  onkeydown={(e) => { if (e.key === 'Enter') handleClick(); }}
  role="treeitem"
  aria-selected={isSelected}
  tabindex="-1"
>
  {#if hasChildren}
    <span class={cn('text-[9px] transition-transform text-fg-muted shrink-0 w-3 text-center', isOpen && 'rotate-90')} aria-hidden="true">▶</span>
  {/if}
  <span class="flex-1 text-ui whitespace-nowrap overflow-hidden text-ellipsis">
    {itemIsTest ? (testItem.browser ?? testItem.title) : suiteItem.path[suiteItem.path.length - 1] ?? 'Tests'}
  </span>
  {#if runEnabled && !isRunning}
    <button
      class="opacity-0 group-hover:opacity-100 size-5 flex items-center justify-center text-success text-[10px] hover:bg-surface-hover rounded transition-opacity"
      aria-label="Run {itemIsTest ? 'test' : 'suite'}"
      title="Run {itemIsTest ? 'this test' : 'this suite'}"
      onclick={(e) => { e.stopPropagation(); onRun(item); }}
    >&#9654;</button>
  {/if}
  {#if item.status}
    <span class={cn('size-2 rounded-full inline-block shrink-0', statusDotClass(item.status))}></span>
  {/if}
</div>
```

Key details:

- The row div gains `group` in its class list to enable `group-hover` for the button.
- The button has `opacity-0 group-hover:opacity-100` so it only appears on hover.
- `e.stopPropagation()` prevents the row's `onclick` (select/open) from firing.
- The `▶` glyph (`&#9654;`) matches the existing Start button icon for consistency.
- The button is hidden when `!runEnabled` or `isRunning` — same gate as the global Start button.

- [ ] **Step 2: Verify build**

Run: `bun run build`
Expected: PASS (svelte compiles, dist written).

- [ ] **Step 3: Commit Tasks 1–3 together**

```bash
git add src/client/App.svelte src/client/components/Sidebar.svelte src/client/components/TreeItem.svelte
git commit -m "feat(client): add per-test and per-suite run buttons to sidebar tree"
```

---

## Task 4: Verify end-to-end

**Files:** none (verification only)

- [ ] **Step 1: Run the full check pipeline**

Run: `bun run check`
Expected: PASS.

- [ ] **Step 2: Manual smoke**

In one terminal:

```bash
bun run start
```

In another, from a project that uses `@crvy/rprtr`:

```bash
npx playwright test
```

Open http://localhost:3000. Expected:

- Hovering a test in the tree reveals a ▶ button on the right edge.
- Clicking ▶ starts a run scoped to that test's `file:line`.
- Hovering a suite reveals the same ▶ button.
- Clicking ▶ on a suite starts a run scoped to all descendant tests' `file:line` locations.
- The global Start button still runs the entire suite (no filters).
- While a run is in progress, the hover buttons disappear (gated by `!isRunning`).
- The Stop (■) button remains available to interrupt any run.
