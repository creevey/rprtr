import { describe, expect, test } from 'bun:test'

import { isAnyAbsolutePath, isForeignAbsolutePath } from '../src/path-utils'

describe('isAnyAbsolutePath', () => {
  test('recognises POSIX absolute paths', () => {
    expect(isAnyAbsolutePath('/Users/ki/test.png')).toBe(true)
    expect(isAnyAbsolutePath('/tmp/test.png')).toBe(true)
  })

  test('recognises Windows drive paths', () => {
    expect(isAnyAbsolutePath('C:\\work-projects\\test.png')).toBe(true)
    expect(isAnyAbsolutePath('D:/photos/x.png')).toBe(true)
  })

  test('recognises UNC paths', () => {
    expect(isAnyAbsolutePath('\\\\server\\share\\test.png')).toBe(true)
  })

  test('rejects relative paths', () => {
    expect(isAnyAbsolutePath('test-results/x.png')).toBe(false)
    expect(isAnyAbsolutePath('./screenshots/x.png')).toBe(false)
    expect(isAnyAbsolutePath('')).toBe(false)
  })
})

describe('isForeignAbsolutePath', () => {
  test('POSIX path is foreign on Windows host', () => {
    expect(isForeignAbsolutePath('/Users/ki/test.png', 'win32')).toBe(true)
  })

  test('Windows drive path is foreign on POSIX host', () => {
    expect(isForeignAbsolutePath('C:\\work\\test.png', 'linux')).toBe(true)
    expect(isForeignAbsolutePath('C:\\work\\test.png', 'darwin')).toBe(true)
  })

  test('same-OS absolute path is not foreign', () => {
    expect(isForeignAbsolutePath('/Users/ki/test.png', 'darwin')).toBe(false)
    expect(isForeignAbsolutePath('/home/u/test.png', 'linux')).toBe(false)
    expect(isForeignAbsolutePath('C:\\work\\test.png', 'win32')).toBe(false)
  })

  test('relative paths are never foreign', () => {
    expect(isForeignAbsolutePath('test-results/x.png', 'darwin')).toBe(false)
    expect(isForeignAbsolutePath('test-results/x.png', 'win32')).toBe(false)
  })
})
