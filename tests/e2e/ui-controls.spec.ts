import { test, expect, type Page } from '@playwright/test'

const isPlaywright = (): boolean =>
  process.env.PLAYWRIGHT_WORKER_INDEX !== undefined || process.env.PW_TEST !== undefined

if (isPlaywright()) {
  const BASE = 'http://localhost:3001/tests/e2e/ui-controls.html'

  const SECTIONS = [
    'view-mode-switcher',
    'status-indicators',
    'status-filter-buttons',
    'filter-input',
    'tree-items',
    'action-buttons',
    'image-name-tabs',
    'toggle-switch',
    'update-mode-badge',
    'empty-states',
    'sidebar-panel',
  ] as const

  const gotoFixture = async (page: Page, theme: 'dark' | 'light'): Promise<void> => {
    const url = theme === 'light' ? `${BASE}?theme=light` : BASE
    await page.goto(url)
    await page.waitForSelector('[data-section]')
  }

  test.describe('UI Controls Fixture', () => {
    test.describe('dark theme', () => {
      test('full page', async ({ page }) => {
        await gotoFixture(page, 'dark')
        await expect(page).toHaveScreenshot('dark-full-page.png', { fullPage: true })
      })

      for (const section of SECTIONS) {
        test(section, async ({ page }) => {
          await gotoFixture(page, 'dark')
          const el = page.locator(`[data-section="${section}"]`)
          await expect(el).toHaveScreenshot(`dark-${section}.png`)
        })
      }
    })

    test.describe('light theme', () => {
      test('full page', async ({ page }) => {
        await gotoFixture(page, 'light')
        await expect(page).toHaveScreenshot('light-full-page.png', { fullPage: true })
      })

      for (const section of SECTIONS) {
        test(section, async ({ page }) => {
          await gotoFixture(page, 'light')
          const el = page.locator(`[data-section="${section}"]`)
          await expect(el).toHaveScreenshot(`light-${section}.png`)
        })
      }
    })
  })
}
