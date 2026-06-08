import { expect, test } from 'bun:test'
import { join } from 'path'

import { attachmentsToImages } from '../src/report-utils'

test('attachmentsToImages routes absolute paths to /file URLs', () => {
  const abs = join(process.cwd(), 'test-results', 't1', 'shot-actual.png')
  const images = attachmentsToImages([{ name: 'shot-actual.png', path: abs, contentType: 'image/png' }])
  expect(images['shot']?.actual).toBe(`/file/${encodeURIComponent(abs)}`)
})

test('attachmentsToImages keeps relative paths under the base url', () => {
  const images = attachmentsToImages([
    { name: 'shot-actual.png', path: 't1/shot-actual.png', contentType: 'image/png' },
  ])
  expect(images['shot']?.actual).toBe('/screenshots/t1/shot-actual.png')
})
