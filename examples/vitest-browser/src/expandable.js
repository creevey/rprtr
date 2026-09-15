/**
 * @typedef {object} ExpandableProps
 * @property {string} [title]
 * @property {boolean} [expanded]
 */

/**
 * @typedef {object} ExpandableInstance
 * @property {HTMLElement} root
 * @property {(props: Partial<ExpandableProps>) => void} update
 * @property {(listener: (expanded: boolean) => void) => void} onToggle
 */

/**
 * Stateful component: `expanded` lives inside the component and survives
 * `update(props)` — the same way framework state survives a re-render.
 *
 * @param {ExpandableProps} [props]
 * @returns {ExpandableInstance}
 */
export function Expandable(props = {}) {
  const state = {
    title: props.title ?? 'Advanced settings',
    expanded: props.expanded ?? false,
  }
  /** @type {((expanded: boolean) => void) | null} */
  let onToggle = null

  const root = document.createElement('div')
  root.style.font = '14px sans-serif'

  const header = document.createElement('button')
  header.type = 'button'
  header.style.cssText =
    'display: block; padding: 8px 12px; border: 1px solid #cbd5e1; border-radius: 8px; background: #ffffff; font: 600 14px sans-serif;'

  const body = document.createElement('div')
  body.style.cssText = 'margin-top: 8px; padding: 12px; border: 1px dashed #cbd5e1; border-radius: 8px; color: #475569;'
  body.textContent = 'These settings only appear while the component is expanded.'

  const render = () => {
    header.textContent = `${state.title} ${state.expanded ? '▾' : '▸'}`
    header.setAttribute('aria-expanded', String(state.expanded))
    body.hidden = !state.expanded
  }

  header.addEventListener('click', () => {
    state.expanded = !state.expanded
    render()
    onToggle?.(state.expanded)
  })

  root.append(header, body)
  render()

  return {
    root,
    update(next = {}) {
      if (next.title !== undefined) state.title = next.title
      render()
    },
    onToggle(listener) {
      onToggle = listener
    },
  }
}
