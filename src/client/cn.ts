/** @public — used by Svelte components (knip does not trace .svelte imports) */
export function cn(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(' ')
}

/** @public — used by Svelte components (knip does not trace .svelte imports) */
export function statusDotClass(status?: string): string {
  switch (status) {
    case 'success':
      return 'bg-success'
    case 'failed':
      return 'bg-error'
    case 'pending':
      return 'bg-warning'
    case 'approved':
      return 'bg-info'
    case 'running':
      return 'bg-warning animate-pulse-dot'
    case 'unknown':
    case undefined:
      return 'bg-fg-muted'
    default:
      return 'bg-fg-muted'
  }
}

/** @public — used by Svelte components (knip does not trace .svelte imports) */
export function pinBadgeClass(status: string): string {
  switch (status) {
    case 'pinned':
      return 'border-success/40 bg-success/10 text-success'
    case 'drift':
      return 'border-error/40 bg-error/10 text-error'
    default:
      return 'border-edge bg-surface-input text-fg-muted'
  }
}
