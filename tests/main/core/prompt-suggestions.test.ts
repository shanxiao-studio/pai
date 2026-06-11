import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { afterEach, describe, expect, it } from 'vitest'
import { listSkillSuggestions, searchProjectFiles } from '../../../src/main/core/prompt-suggestions'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
  roots.length = 0
})

async function tempRoot() {
  const root = await mkdtemp(join(tmpdir(), 'pai-suggestions-'))
  roots.push(root)
  return root
}

describe('prompt suggestions', () => {
  it('merges project skills before global skills and deduplicates by name', async () => {
    const skillsRoot = await tempRoot()
    await mkdir(join(skillsRoot, 'git-commit'), { recursive: true })
    await mkdir(join(skillsRoot, 'drawio'), { recursive: true })
    await writeFile(join(skillsRoot, 'git-commit', 'SKILL.md'), '---\nname: git-commit\ndescription: Global commit helper\n---\n')
    await writeFile(join(skillsRoot, 'drawio', 'SKILL.md'), '---\nname: drawio\ndescription: Diagram helper\n---\n')

    const suggestions = await listSkillSuggestions([
      { name: 'git-commit', source: 'project-skill' },
    ], skillsRoot)

    expect(suggestions).toEqual([
      { name: 'git-commit', source: 'project', path: 'project-skill' },
      { name: 'drawio', source: 'global', path: join(skillsRoot, 'drawio', 'SKILL.md'), description: 'Diagram helper' },
    ])
  })

  it('searches project files using gitignore rules first', async () => {
    const projectRoot = await tempRoot()
    await mkdir(join(projectRoot, 'src'), { recursive: true })
    await mkdir(join(projectRoot, 'node_modules', 'pkg'), { recursive: true })
    await mkdir(join(projectRoot, 'generated'), { recursive: true })
    await writeFile(join(projectRoot, 'src', 'ChatView.tsx'), '')
    await writeFile(join(projectRoot, 'node_modules', 'pkg', 'ChatView.tsx'), '')
    await writeFile(join(projectRoot, 'generated', 'ChatView.tsx'), '')
    await writeFile(join(projectRoot, '.gitignore'), 'node_modules/\ngenerated/\n')

    await expect(searchProjectFiles(projectRoot, 'chat')).resolves.toEqual(['src/ChatView.tsx'])
  })

  it('allows gitignore negation rules', async () => {
    const projectRoot = await tempRoot()
    await mkdir(join(projectRoot, 'src'), { recursive: true })
    await writeFile(join(projectRoot, 'src', 'keep.ts'), '')
    await writeFile(join(projectRoot, 'src', 'skip.ts'), '')
    await writeFile(join(projectRoot, '.gitignore'), '*.ts\n!src/keep.ts\n')

    await expect(searchProjectFiles(projectRoot, 'ts')).resolves.toEqual(['src/keep.ts'])
  })
})
