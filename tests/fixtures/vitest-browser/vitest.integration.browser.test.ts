import { expect, test } from 'vitest'
import { page } from 'vitest/browser'

declare const __HERO_COLOR__: string

test('captures screenshot diff for crvy rprtr reporter', async () => {
  document.body.innerHTML = `
    <style>
      html, body {
        margin: 0;
        background: #f8fafc;
        font-family: sans-serif;
      }

      [data-testid="hero"] {
        width: 120px;
        height: 48px;
        margin: 24px;
        border-radius: 12px;
        background: ${__HERO_COLOR__};
        box-shadow: 0 0 0 2px rgba(15, 23, 42, 0.12) inset;
      }
    </style>
    <div data-testid="hero"></div>
  `

  await expect(page.getByTestId('hero')).toMatchScreenshot('hero-section')
})
