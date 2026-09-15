import { expect, test } from 'vitest'
import { page } from 'vitest/browser'

import { Expandable } from '../src/expandable.js'

// Interaction + state + visual regression in one test: the test clicks like
// a user, asserts the component's internal state flipped, and screenshots
// the whole root to capture the expanded rendering.
test('expands on click and matches the expanded baseline', async () => {
  const expandable = Expandable()
  expandable.root.dataset.testid = 'expandable'
  document.body.append(expandable.root)

  const header = page.getByRole('button', { name: /Advanced settings/ })
  const body = page.getByText('These settings only appear while the component is expanded.')

  await expect.element(header).toHaveAttribute('aria-expanded', 'false')
  await expect.element(body).not.toBeVisible()

  await header.click()

  await expect.element(header).toHaveAttribute('aria-expanded', 'true')
  await expect.element(body).toBeVisible()

  await expect(page.getByTestId('expandable')).toMatchScreenshot('expandable-expanded')
})
