import { expect, test } from 'vitest'
import { page } from 'vitest/browser'

// Source sample consumed by tests/vitest-declarations.test.ts to exercise
// extraction from a real file on disk.
test('renders hero section', async () => {
  await expect(page.getByTestId('hero')).toMatchScreenshot('hero-section')
})
