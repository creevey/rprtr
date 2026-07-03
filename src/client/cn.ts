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
