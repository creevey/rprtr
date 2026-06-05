<script lang="ts">
  import type { Images } from '../../types';

  interface Props {
    image: Partial<Images>;
  }

  let { image }: Props = $props();

  let isLandscape = $state(false);
  let expectedLabel = $derived(image.source === 'baseline-only' && !image.actual && !image.diff ? 'Baseline' : 'Expected');

  $effect(() => {
    const src = image.diff ?? image.expect ?? image.actual;
    if (!src) return;
    const img = document.createElement('img');
    img.src = src;
    const check = (): void => { isLandscape = img.naturalWidth > img.naturalHeight; };
    if (img.complete) check();
    else img.onload = check;
  });
</script>

<div class="flex gap-3 items-start" class:flex-col={isLandscape} class:flex-row={!isLandscape}>
  {#if image.expect}
    <div class="flex-1 flex flex-col bg-surface-panel rounded-md overflow-hidden min-w-0 border-2 border-green-500/60">
      <h3 class="m-0 px-3 py-2 text-xs font-bold bg-green-500/25 text-green-800 dark:text-green-200 uppercase tracking-wider">{expectedLabel}</h3>
      <div class="flex items-center justify-center p-2">
        <img src={image.expect} alt="Expected" class="w-auto max-w-full object-contain mx-auto" loading="lazy" />
      </div>
    </div>
  {/if}
  {#if image.diff}
    <div class="flex-1 flex flex-col bg-surface-panel rounded-md overflow-hidden min-w-0 border-2 border-yellow-500/60">
      <h3 class="m-0 px-3 py-2 text-xs font-bold bg-yellow-500/25 text-yellow-800 dark:text-yellow-200 uppercase tracking-wider">Diff</h3>
      <div class="flex items-center justify-center p-2">
        <img src={image.diff} alt="Diff" class="w-auto max-w-full object-contain mx-auto" loading="lazy" />
      </div>
    </div>
  {/if}
  {#if image.actual}
    <div class="flex-1 flex flex-col bg-surface-panel rounded-md overflow-hidden min-w-0 border-2 border-red-500/60">
      <h3 class="m-0 px-3 py-2 text-xs font-bold bg-red-500/25 text-red-800 dark:text-red-200 uppercase tracking-wider">Actual</h3>
      <div class="flex items-center justify-center p-2">
        <img src={image.actual} alt="Actual" class="w-auto max-w-full object-contain mx-auto" loading="lazy" />
      </div>
    </div>
  {/if}
</div>
