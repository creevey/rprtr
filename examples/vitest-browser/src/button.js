/**
 * @typedef {object} ButtonProps
 * @property {string} [label]
 * @property {'solid' | 'outline'} [variant]
 */

/**
 * @typedef {object} ButtonInstance
 * @property {HTMLButtonElement} root
 * @property {(props: Partial<ButtonProps>) => void} update
 */

/**
 * Change this constant and rerun `bun run test` to see a visual diff in the
 * rprtr UI — then click Approve to make it the new baseline.
 */
export const ACCENT_COLOR = '#2563eb'

/**
 * A tiny vanilla "component": a factory that returns `{ root, update }`.
 * `update` re-renders in place (reconciliation), so a test can change props
 * while keeping the same element.
 *
 * @param {ButtonProps} [props]
 * @returns {ButtonInstance}
 */
export function Button(props = {}) {
  const state = {
    label: props.label ?? 'Save changes',
    variant: props.variant ?? 'solid',
  }
  const root = document.createElement('button')
  root.type = 'button'
  root.style.padding = '8px 16px'
  root.style.borderRadius = '8px'
  root.style.font = '600 14px sans-serif'

  const render = () => {
    root.textContent = state.label
    if (state.variant === 'solid') {
      root.style.background = ACCENT_COLOR
      root.style.color = '#ffffff'
      root.style.border = '1px solid transparent'
    } else {
      root.style.background = 'transparent'
      root.style.color = ACCENT_COLOR
      root.style.border = `1px solid ${ACCENT_COLOR}`
    }
  }

  render()

  return {
    root,
    update(next = {}) {
      if (next.label !== undefined) state.label = next.label
      if (next.variant !== undefined) state.variant = next.variant
      render()
    },
  }
}
