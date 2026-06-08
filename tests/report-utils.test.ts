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

test('attachmentsToImages /file URL round-trips back to the absolute path', () => {
  const abs = join(process.cwd(), 'test-results', 't1', 'shot-actual.png')
  const images = attachmentsToImages([{ name: 'shot-actual.png', path: abs, contentType: 'image/png' }])
  const url = images['shot']?.actual ?? ''
  expect(decodeURIComponent(url.slice('/file/'.length))).toBe(abs)
})

test('attachmentsToImages routes absolute diff paths to /file URLs', () => {
  const abs = join(process.cwd(), 'test-results', 't1', 'shot-diff.png')
  const images = attachmentsToImages([{ name: 'shot-diff.png', path: abs, contentType: 'image/png' }])
  expect(images['shot']?.diff).toBe(`/file/${encodeURIComponent(abs)}`)
})
