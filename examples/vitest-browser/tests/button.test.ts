import { expect, test } from 'vitest'
import { page } from 'vitest/browser'

import { Button } from '../src/button.js'

// Plain DOM assertion: the component renders in the real browser (Vite
// compiles and serves this module into Chromium), everything else is an
// ordinary vitest assertion against the live document.
test('renders props and updates in place', async () => {
  const button = Button({ label: 'Save changes' })
  button.root.dataset.testid = 'button'
  document.body.append(button.root)

  const locator = page.getByTestId('button')
  await expect.element(locator).toHaveTextContent('Save changes')

  // update() re-renders in place; the element (and locator) stay valid.
  button.update({ label: 'Saved!', variant: 'outline' })
  await expect.element(locator).toHaveTextContent('Saved!')
})

// Visual regression: screenshot the button element itself for a tight
// baseline. On the first run vitest writes the baseline and the test FAILS
// (Playwright-like UX); from then on any pixel change fails with
// reference/actual/diff paths, which @crvy/rprtr shows in its UI.
test('matches the button baseline', async () => {
  const button = Button()
  button.root.dataset.testid = 'button-solid'
  document.body.append(button.root)

  await expect(page.getByTestId('button-solid')).toMatchScreenshot('button-solid')
})
