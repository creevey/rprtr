#!/usr/bin/env bun
/**
 * `git-cliff --prepend` inserts the generated release section below the
 * configured header but leaves any hand-written `## [Unreleased]` section in
 * place, so the published changelog can carry a stale duplicate. This module
 * removes every `## [Unreleased]` section — heading, body, and one adjacent
 * separator blank line — leaving only generated release sections.
 */

const UNRELEASED_HEADING = /^## \[Unreleased\]\s*$/
const RELEASE_HEADING = /^## \[/

export function stripUnreleasedSections(markdown: string): { markdown: string; removed: number } {
  const lines = markdown.split('\n')
  if (!lines.some((line) => UNRELEASED_HEADING.test(line))) {
    return { markdown, removed: 0 }
  }

  const kept: string[] = []
  let removed = 0
  let index = 0

  while (index < lines.length) {
    const line = lines[index] ?? ''
    if (!UNRELEASED_HEADING.test(line)) {
      kept.push(line)
      index++
      continue
    }

    removed++
    let end = index + 1
    while (end < lines.length && !RELEASE_HEADING.test(lines[end] ?? '')) end++

    // `git-cliff --prepend` can land the generated section flush against the
    // swept heading; keep one blank line before the next release heading.
    if (end < lines.length && kept.length > 0 && kept.at(-1) !== '') kept.push('')

    index = end
  }

  const result = kept.join('\n')
  if (markdown.endsWith('\n') && !result.endsWith('\n')) return { markdown: `${result}\n`, removed }

  return { markdown: result, removed }
}

if (import.meta.main) {
  const path = process.argv[2]
  if (path === undefined) {
    console.error('Usage: bun scripts/strip-unreleased-changelog.ts <changelog-file>')
    process.exit(1)
  }

  const { markdown, removed } = stripUnreleasedSections(await Bun.file(path).text())
  if (removed > 0) await Bun.write(path, markdown)
  console.log(`✓ Removed ${removed} [Unreleased] section(s) from ${path}`)
}
