import { describe, expect, test } from 'bun:test'

import { findAbsoluteResolutions } from '../scripts/check-lockfiles.ts'

// The exact entry that turned `main` red: a locally packed tarball installed
// from a macOS temp dir, whose path does not exist on a Linux runner.
const LOCAL_TARBALL_ENTRY =
  '    "@crvy/rprtr": ["@crvy/rprtr@/var/folders/bb/4_lkm1wx25q1vtz97xy66hd40000gn/T/opencode/crvy-rprtr-0.3.3.tgz", { "dependencies": {} }, "sha512-abc=="],'

const REGISTRY_ENTRY = '    "@crvy/rprtr": ["@crvy/rprtr@0.3.3", "", { "dependencies": {} }, "sha512-abc=="],'

describe('findAbsoluteResolutions', () => {
  test('flags a dependency resolved to an absolute posix path', () => {
    expect(findAbsoluteResolutions(LOCAL_TARBALL_ENTRY)).toEqual([
      '@crvy/rprtr@/var/folders/bb/4_lkm1wx25q1vtz97xy66hd40000gn/T/opencode/crvy-rprtr-0.3.3.tgz',
    ])
  })

  test('flags a dependency resolved to an absolute windows path', () => {
    const entry = String.raw`    "left-pad": ["left-pad@C:\Users\dev\AppData\Local\Temp\left-pad.tgz", { }, "sha512-abc=="],`
    expect(findAbsoluteResolutions(entry)).toEqual([String.raw`left-pad@C:\Users\dev\AppData\Local\Temp\left-pad.tgz`])
  })

  test('accepts a registry resolution', () => {
    expect(findAbsoluteResolutions(REGISTRY_ENTRY)).toEqual([])
  })

  test('accepts a workspace-relative resolution', () => {
    const entry = '    "shared": ["shared@workspace:packages/shared", { }],'
    expect(findAbsoluteResolutions(entry)).toEqual([])
  })

  test('reports every offending resolution in a file', () => {
    expect(findAbsoluteResolutions(`${LOCAL_TARBALL_ENTRY}\n${REGISTRY_ENTRY}\n${LOCAL_TARBALL_ENTRY}`)).toHaveLength(2)
  })
})
