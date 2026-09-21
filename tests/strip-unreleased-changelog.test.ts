import { describe, expect, test } from 'bun:test'

import { stripUnreleasedSections } from '../scripts/strip-unreleased-changelog.ts'

const HEADER = `# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

`

const RELEASES = `## [0.3.3] - 2026-09-14

### Added

- **rendering:** Pin grayscale text antialiasing in every run mode

## [0.3.2] - 2026-08-25

### Fixed

- **docker:** Stop forwarding host HOME and Windows-path env into the container
`

const GENERATED = `## [0.4.0] - 2026-09-21

### Added

- **vitest:** Add vitest reporter build surface and deps
`

const CURATED_UNRELEASED = `## [Unreleased]

### Changed

- **deps:** \`@playwright/test\` and \`vitest\` are now optional peer dependencies.

### Fixed

- **reporter:** Importing a reporter whose test runner is not installed now fails with a helpful message.

`

// Mirrors CHANGELOG.md: the orphaned `[Unreleased]` + `# test` block sits
// directly after the last release bullet, with no blank separator.
const ORPHAN_UNRELEASED = '## [Unreleased]\n# test\n'

describe('stripUnreleasedSections', () => {
  test('removes the curated top section with its body and separator', () => {
    const result = stripUnreleasedSections(HEADER + CURATED_UNRELEASED + RELEASES)

    expect(result.removed).toBe(1)
    expect(result.markdown).toBe(HEADER + RELEASES)
  })

  test('removes the orphaned EOF section and leaves one trailing newline', () => {
    const result = stripUnreleasedSections(HEADER + RELEASES + ORPHAN_UNRELEASED)

    expect(result.removed).toBe(1)
    expect(result.markdown).toBe(HEADER + RELEASES)
    expect(result.markdown.endsWith('\n')).toBe(true)
    expect(result.markdown.endsWith('\n\n')).toBe(false)
  })

  test('removes a blank separator line that precedes an EOF section', () => {
    const result = stripUnreleasedSections(`${HEADER}${RELEASES}\n${ORPHAN_UNRELEASED}`)

    expect(result.removed).toBe(1)
    expect(result.markdown).toBe(HEADER + RELEASES)
  })

  test('restores a blank separator when the swept section is glued to the generated section', () => {
    // `git-cliff --prepend` inserts the generated section directly before the
    // curated `[Unreleased]` heading, so sweeping it would otherwise glue the
    // last generated bullet to the next release heading.
    const result = stripUnreleasedSections(HEADER + GENERATED + CURATED_UNRELEASED + RELEASES)

    expect(result.removed).toBe(1)
    expect(result.markdown).toBe(`${HEADER}${GENERATED}\n${RELEASES}`)
  })

  test('returns a changelog without an [Unreleased] section byte-for-byte', () => {
    const input = HEADER + RELEASES

    expect(stripUnreleasedSections(input)).toEqual({ markdown: input, removed: 0 })
  })

  test('is idempotent', () => {
    const once = stripUnreleasedSections(HEADER + CURATED_UNRELEASED + RELEASES + ORPHAN_UNRELEASED)

    expect(once.removed).toBe(2)
    expect(stripUnreleasedSections(once.markdown)).toEqual({ markdown: once.markdown, removed: 0 })
  })

  test('keeps every other release section unchanged', () => {
    const result = stripUnreleasedSections(HEADER + CURATED_UNRELEASED + RELEASES + ORPHAN_UNRELEASED)

    expect(result.markdown).toContain(RELEASES)
    expect(result.markdown.match(/^## \[\d[^\]]*\]/gm)).toEqual(['## [0.3.3]', '## [0.3.2]'])
  })
})
