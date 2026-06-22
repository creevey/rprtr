<script lang="ts">
  import { isTest, isDefined, type CrvyRprtrSuite, type CrvyRprtrTest } from '../../types';
  import { getTestPath, hasScreenshots } from '../helpers';
  import { cn, statusDotClass } from '../cn';
  import TreeItem from './TreeItem.svelte';

  interface Props {
    item: CrvyRprtrSuite | CrvyRprtrTest;
    level: number;
    selectedId?: string;
    focusedPath: string[] | null;
    isUpdateMode: boolean;
    runEnabled: boolean;
    isRunning: boolean;
    onSelect: (test: CrvyRprtrTest) => void;
    onOpen: (path: string[], opened: boolean) => void;
    onToggle: (path: string[], checked: boolean) => void;
    onRun: (item: CrvyRprtrSuite | CrvyRprtrTest) => void;
  }

  let { item, level, selectedId, focusedPath, isUpdateMode, runEnabled, isRunning, onSelect, onOpen, onToggle, onRun }: Props = $props();

  let itemIsTest = $derived(isTest(item));
  let suiteItem = $derived(item as CrvyRprtrSuite);
  let testItem = $derived(item as CrvyRprtrTest);
  let path = $derived(itemIsTest ? getTestPath(testItem) : suiteItem.path);
  let hasChildren = $derived(!itemIsTest && Object.keys(suiteItem.children).length > 0);
  let isOpen = $derived(!itemIsTest && suiteItem.opened);
  let isSelected = $derived(itemIsTest && testItem.id === selectedId);
  let isFocused = $derived(
    focusedPath !== null &&
    path.length === focusedPath.length &&
    path.every((p, i) => p === focusedPath[i])
  );

  let rowEl: HTMLDivElement | undefined = $state();

  function handleClick(): void {
    if (itemIsTest) onSelect(testItem);
    else onOpen(suiteItem.path, !isOpen);
  }

  $effect(() => {
    if (isFocused && rowEl) {
      rowEl.scrollIntoView({ block: 'nearest' });
    }
  });
</script>

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
  {#if runEnabled}
    <button
      class={cn(
        'size-5 flex items-center justify-center text-success text-[10px] rounded transition-opacity',
        isRunning
          ? 'opacity-0 pointer-events-none'
          : 'opacity-0 group-hover:opacity-100 focus:opacity-100 hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-accent',
      )}
      aria-label="Run {itemIsTest ? 'this test' : 'this suite'}"
      title="Run {itemIsTest ? 'this test' : 'this suite'}"
      disabled={isRunning}
      onclick={(e) => { e.stopPropagation(); onRun(item); }}
      onkeydown={(e) => e.stopPropagation()}
    >&#9654;</button>
  {/if}
  {#if item.status}
    <span class={cn('size-2 rounded-full inline-block shrink-0', statusDotClass(item.status))}></span>
  {/if}
</div>

{#if isOpen}
  {#each Object.values(suiteItem.children).filter(isDefined).filter((c) => hasScreenshots(c as CrvyRprtrSuite | CrvyRprtrTest)) as child}
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
  {/each}
{/if}
