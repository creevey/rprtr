import { describe, expect, test } from 'bun:test'

import { parseImageBrowserRevisions, parseImageBrowserRevisionsEnv } from '../src/image-browsers'
import type { DockerExec, DockerExecResult } from '../src/server/docker-support'
import { probeImageBrowsers } from '../src/server/image-browsers'

const OK: DockerExecResult = { exitCode: 0, stdout: '', stderr: '' }

describe('parseImageBrowserRevisions', () => {
  test('groups browser cache directories by browser and ignores everything else', () => {
    const revisions = parseImageBrowserRevisions(
      'chromium-1217\nchromium_headless_shell-1217\nfirefox-1511\nwebkit-2272\nffmpeg-1011\n',
    )

    expect(revisions).toEqual({ chromium: ['1217'], firefox: ['1511'], webkit: ['2272'] })
  })

  test('keeps every revision present for the same browser', () => {
    const revisions = parseImageBrowserRevisions('chromium-1217\nchromium-1290\nwebkit-2272\n')

    expect(revisions).toEqual({ chromium: ['1217', '1290'], webkit: ['2272'] })
  })

  test('returns no entries when the output has no browser cache directories', () => {
    expect(parseImageBrowserRevisions('ffmpeg-1011\nnot-a-browser\n\n')).toEqual({})
  })
})

describe('parseImageBrowserRevisionsEnv', () => {
  test('parses a JSON revision map', () => {
    expect(parseImageBrowserRevisionsEnv('{"chromium":["1217"],"firefox":["1511"]}')).toEqual({
      chromium: ['1217'],
      firefox: ['1511'],
    })
  })

  test('returns undefined for a missing, malformed, or non-revision payload', () => {
    expect(parseImageBrowserRevisionsEnv(undefined)).toBeUndefined()
    expect(parseImageBrowserRevisionsEnv('')).toBeUndefined()
    expect(parseImageBrowserRevisionsEnv('not json')).toBeUndefined()
    expect(parseImageBrowserRevisionsEnv('{"chromium":["latest"]}')).toBeUndefined()
    expect(parseImageBrowserRevisionsEnv('{"opera":["1"]}')).toBeUndefined()
  })
})

describe('probeImageBrowsers', () => {
  test('reads the browser cache directories in a no-network container', async () => {
    const calls: string[][] = []
    const exec: DockerExec = (args) => {
      calls.push(args)
      return Promise.resolve({ exitCode: 0, stdout: 'chromium-1217\nfirefox-1511\n', stderr: '' })
    }

    const revisions = await probeImageBrowsers({ exec, image: 'registry.example/playwright:v1.59.0' })

    expect(revisions).toEqual({ chromium: ['1217'], firefox: ['1511'] })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.slice(0, 7)).toEqual([
      'run',
      '--rm',
      '--network',
      'none',
      '--entrypoint',
      'sh',
      'registry.example/playwright:v1.59.0',
    ])
    expect(calls[0]!.at(-1)).toContain('PLAYWRIGHT_BROWSERS_PATH')
    expect(calls[0]!.at(-1)).toContain('/ms-playwright')
  })

  test('returns null when the image cannot be probed', async () => {
    const exec: DockerExec = () => Promise.resolve({ exitCode: 125, stdout: '', stderr: 'no such image' })

    expect(await probeImageBrowsers({ exec, image: 'missing/image:1' })).toBeNull()
  })

  test('returns null when the exec itself throws', async () => {
    const exec: DockerExec = () => Promise.reject(new Error('docker is not running'))

    expect(await probeImageBrowsers({ exec, image: 'image:1' })).toBeNull()
  })

  test('returns null when the image has no browser directories', async () => {
    const exec: DockerExec = () => Promise.resolve({ ...OK, stdout: 'ffmpeg-1011\n' })

    expect(await probeImageBrowsers({ exec, image: 'image:1' })).toBeNull()
  })
})
