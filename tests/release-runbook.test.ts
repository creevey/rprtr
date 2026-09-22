import { describe, expect, test } from 'bun:test'

const SKILL_PATHS = {
  opencode: new URL('../.opencode/skills/release-runbook/SKILL.md', import.meta.url),
  claude: new URL('../.claude/skills/release-runbook/SKILL.md', import.meta.url),
}

async function readSkill(path: URL): Promise<string> {
  const file = Bun.file(path)
  if (!(await file.exists())) throw new Error(`missing skill file: ${path.pathname}`)
  return file.text()
}

describe('release-runbook skill', () => {
  test('exists in both agent tooling directories byte-identical', async () => {
    const opencode = await readSkill(SKILL_PATHS.opencode)
    const claude = await readSkill(SKILL_PATHS.claude)
    expect(opencode).toContain('name: release-runbook')
    expect(opencode).toBe(claude)
  })

  test('runs preflight and dispatches only behind the confirmation gate', async () => {
    const skill = await readSkill(SKILL_PATHS.opencode)
    expect(skill).toContain('bun run release:preflight')
    expect(skill).toContain('gh workflow run publish.yml')
    expect(skill).toContain('Confirmation gate')
    expect(skill).toContain('explicit confirmation')
    expect(skill).toContain('READY')
  })

  test('documents every recovery stage and the never-do list', async () => {
    const skill = await readSkill(SKILL_PATHS.opencode)
    for (const stage of [
      'Nothing pushed',
      'Release commit pushed, no tag',
      'Tag pushed, version unpublished',
      'Version published, no GitHub release',
      'Version published and defective',
    ]) {
      expect(skill).toContain(stage)
    }
    expect(skill).toContain('Never run `npm publish`')
    expect(skill).toContain('Never `git push` a release commit or tag by hand')
  })
})
