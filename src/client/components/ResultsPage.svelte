<script lang="ts">
  import type { CrvyRprtrTest, ImagesViewMode } from '../../types';
  import { viewModes, VIEW_MODE_KEY } from '../viewMode';
  import { cn } from '../cn';
  import SlideView from './SlideView.svelte';
  import SideBySideView from './SideBySideView.svelte';
  import SwapView from './SwapView.svelte';
  import BlendView from './BlendView.svelte';

  interface Props {
    test: CrvyRprtrTest;
    retry: number;
    imageName: string;
    viewMode: ImagesViewMode;
    canApprove: boolean;
    onImageChange: (name: string) => void;
    onRetryChange: (retry: number) => void;
    onViewModeChange: (mode: ImagesViewMode) => void;
  }

  let { test, retry, imageName, viewMode, canApprove, onImageChange, onRetryChange, onViewModeChange }: Props = $props();

  let result = $derived(test.results?.[retry - 1]);
  let image = $derived(result?.images?.[imageName] ?? null);
  let imageNames = $derived(result?.images ? Object.keys(result.images) : []);
  let totalRetries = $derived(test.results?.length ?? 0);
  let hasDiffAndExpect = $derived(Boolean(image?.diff && image?.expect));
  let isDeclaredOnly = $derived(image?.source === 'declared-only');

  let imagesWithError = $derived(
    result?.images
      ? Object.keys(result.images).filter(
          (name) =>
            result!.status !== 'success' &&
            test.approved?.[name] !== retry - 1 &&
            result!.images?.[name]?.diff !== null,
        )
      : []
  );

  let imagesApproved = $derived(
    result?.images
      ? Object.keys(result.images).filter((name) => test.approved?.[name] === retry - 1)
      : []
  );

  function handleKeydown(e: KeyboardEvent): void {
    if (e.code === 'Tab' && hasDiffAndExpect) {
      e.preventDefault();
      const idx = viewModes.indexOf(viewMode);
      if (e.shiftKey) {
        onViewModeChange(viewModes.at((idx - 1) % viewModes.length)!);
      } else {
        onViewModeChange(viewModes.at((idx + 1) % viewModes.length)!);
      }
    }
  }

  $effect(() => {
    localStorage.setItem(VIEW_MODE_KEY, viewMode);
  });

  $effect(() => {
    document.addEventListener('keydown', handleKeydown);
    return (): void => document.removeEventListener('keydown', handleKeydown);
  });
</script>

<div class="flex flex-col h-full">
  <!-- Header -->
  <div class="py-3 px-5 max-md:px-3 bg-surface-alt border-b border-edge flex items-center gap-2 shrink-0">
    <!-- Left: view mode switcher -->
    <div class="flex shrink-0 mr-3">
      {#if hasDiffAndExpect}
        {#each viewModes as mode, i}
          <button
            class={cn(
              'px-2.5 py-1 border text-xs cursor-pointer transition-all focus-visible:ring-2 focus-visible:ring-accent',
              i === 0 && 'rounded-l',
              i === viewModes.length - 1 && 'rounded-r',
              viewMode === mode
                ? 'bg-accent border-accent text-white font-medium shadow-inner'
                : 'bg-surface-input border-edge text-fg-muted hover:text-fg hover:bg-surface-hover',
            )}
            onclick={() => onViewModeChange(mode)}
          >
            {mode}
          </button>
        {/each}
      {/if}
    </div>
    <!-- Center: title and image tabs -->
    <div class="flex-1 flex flex-col items-center min-w-0 pr-10">
      <h2 class="text-base text-fg-bright m-0 font-medium whitespace-nowrap overflow-hidden text-ellipsis text-pretty max-w-full">
        {test.title}
      </h2>
      {#if imageNames.length > 1}
        <div class="flex gap-1 flex-wrap justify-center mt-1">
          {#each imageNames as name}
            <button
              class={cn(
                'px-2.5 py-1 bg-surface-input border rounded-sm text-fg text-xs cursor-pointer transition-colors focus-visible:ring-2 focus-visible:ring-accent',
                name === imageName ? 'bg-accent border-accent text-white' : 'border-edge',
                name !== imageName && imagesWithError.includes(name) && 'border-error',
                name !== imageName && imagesApproved.includes(name) && 'border-success',
              )}
              onclick={() => onImageChange(name)}
            >
              {name}
            </button>
          {/each}
        </div>
      {/if}
    </div>
  </div>

  <!-- Body -->
  <div class="flex-1 overflow-auto min-h-0">
    <div class="min-h-full p-4 max-md:p-2 flex justify-center items-center">
      {#if !image}
        <div class="flex-1 flex items-center justify-center text-fg-muted text-base">No image to display</div>
      {:else if isDeclaredOnly}
        <div class="max-w-xl w-full rounded-md border border-edge bg-surface-panel px-5 py-6 text-center">
          <h3 class="m-0 text-sm font-semibold text-fg-bright uppercase tracking-wide">Passed Visual Assertion</h3>
          <p class="mt-3 text-sm leading-6 text-fg-muted">
            Playwright reported this screenshot assertion, but did not emit an actual, expected, or diff artifact for the passing comparison.
          </p>
        </div>
      {:else if viewMode === 'side-by-side' || !hasDiffAndExpect}
        <div class="w-full flex flex-col gap-3">
          <SideBySideView {image} />
        </div>
      {:else if viewMode === 'swap'}
        <SwapView {image} />
      {:else if viewMode === 'slide'}
        <div class="flex flex-col gap-3">
          {#if image.actual && image.expect && image.diff}
            <SlideView actual={image.actual} expect={image.expect} diff={image.diff} />
          {:else if image.actual}
            <div class="flex flex-col bg-surface-panel rounded-md overflow-hidden min-w-0 border-2 border-red-500/60">
              <h3 class="m-0 px-3 py-2 text-xs font-bold bg-red-500/25 text-red-800 dark:text-red-200 uppercase tracking-wider">Actual</h3>
              <div class="flex items-center justify-center p-2">
                <img src={image.actual} alt="Actual" class="w-auto max-w-full object-contain mx-auto" loading="lazy" />
              </div>
            </div>
          {/if}
        </div>
      {:else if viewMode === 'blend'}
        <div class="w-full flex flex-col gap-3">
          <BlendView {image} />
        </div>
      {/if}
    </div>
  </div>

  <!-- Footer -->
  {#if totalRetries > 1}
    <div class="py-2 px-5 bg-surface-alt border-t border-edge flex items-center justify-center gap-1 shrink-0">
      <button
        class={cn(
          'min-w-7 h-7 flex items-center justify-center bg-surface-input border border-edge rounded text-fg text-xs cursor-pointer transition-colors hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-accent',
          retry <= 1 && 'opacity-30 cursor-not-allowed',
        )}
        disabled={retry <= 1}
        aria-label="Previous retry"
        onclick={() => onRetryChange(retry - 1)}
      >
        &#8249;
      </button>
      <div class="flex gap-0.5 items-center">
        {#each Array.from({ length: totalRetries }, (_, i) => i + 1) as page}
          {#if totalRetries <= 7 || page === 1 || page === totalRetries || Math.abs(page - retry) <= 1}
            <button
              class={cn(
                'min-w-7 h-7 flex items-center justify-center border rounded text-xs cursor-pointer transition-colors focus-visible:ring-2 focus-visible:ring-accent',
                page === retry
                  ? 'bg-accent border-accent text-white'
                  : 'bg-surface-input border-edge text-fg hover:bg-surface-hover',
              )}
              onclick={() => onRetryChange(page)}
            >
              {page}
            </button>
          {:else if page === 2 || page === totalRetries - 1}
            <span class="px-1 text-fg-muted text-xs">{"\u2026"}</span>
          {/if}
        {/each}
      </div>
      <button
        class={cn(
          'min-w-7 h-7 flex items-center justify-center bg-surface-input border border-edge rounded text-fg text-xs cursor-pointer transition-colors hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-accent',
          retry >= totalRetries && 'opacity-30 cursor-not-allowed',
        )}
        disabled={retry >= totalRetries}
        aria-label="Next retry"
        onclick={() => onRetryChange(retry + 1)}
      >
        &#8250;
      </button>
    </div>
  {/if}
</div>
