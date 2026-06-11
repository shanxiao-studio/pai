import { promises as fs } from 'fs'
import { homedir } from 'os'
import { basename, join, relative } from 'path'
import type { DotagentsSkill } from './models'

export type SkillSuggestion = {
  name: string
  source: 'project' | 'global'
  path?: string
  description?: string
}

const ALWAYS_IGNORE_DIRS = new Set(['.git'])
const MAX_FILE_SUGGESTIONS = 20
const MAX_FILE_SCAN_ENTRIES = 2000

export async function listSkillSuggestions(projectSkills: DotagentsSkill[] = [], globalSkillsDir = join(homedir(), '.agents', 'skills')) {
  const suggestions: SkillSuggestion[] = []
  const seen = new Set<string>()

  for (const skill of projectSkills) {
    const name = skill.name.trim()
    if (!name || seen.has(name)) continue
    seen.add(name)
    suggestions.push({
      name,
      source: 'project',
      path: skill.source.trim() || undefined,
    })
  }

  for (const skill of await readGlobalSkills(globalSkillsDir)) {
    if (seen.has(skill.name)) continue
    seen.add(skill.name)
    suggestions.push(skill)
  }

  return suggestions
}

export async function searchProjectFiles(projectPath: string, query: string) {
  const normalizedQuery = query.trim().toLowerCase()
  const ignores = await readGitignore(projectPath)
  const results: string[] = []
  let scanned = 0

  async function walk(dirPath: string) {
    if (results.length >= MAX_FILE_SUGGESTIONS || scanned >= MAX_FILE_SCAN_ENTRIES) return

    let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>
    try {
      entries = await fs.readdir(dirPath, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (results.length >= MAX_FILE_SUGGESTIONS || scanned >= MAX_FILE_SCAN_ENTRIES) return
      if (entry.name.startsWith('.') && entry.name !== '.agents') {
        if (entry.isDirectory()) continue
      }

      const entryPath = join(dirPath, entry.name)
      const filePath = relative(projectPath, entryPath)
      if (entry.isDirectory()) {
        if (ALWAYS_IGNORE_DIRS.has(entry.name) || isIgnored(filePath, true, ignores)) continue
        await walk(entryPath)
        continue
      }

      if (!entry.isFile()) continue
      scanned += 1
      if (isIgnored(filePath, false, ignores)) continue
      if (!normalizedQuery || filePath.toLowerCase().includes(normalizedQuery) || entry.name.toLowerCase().includes(normalizedQuery)) {
        results.push(filePath)
      }
    }
  }

  await walk(projectPath)
  return results
}

async function readGlobalSkills(skillsDir: string) {
  let entries: Array<{ name: string; isDirectory: () => boolean }>
  try {
    entries = await fs.readdir(skillsDir, { withFileTypes: true })
  } catch {
    return []
  }

  const skills = await Promise.all(entries
    .sort((a, b) => a.name.localeCompare(b.name))
    .filter((entry) => entry.isDirectory())
    .map(async (entry): Promise<SkillSuggestion | null> => {
      const skillPath = join(skillsDir, entry.name)
      const mdPath = join(skillPath, 'SKILL.md')
      const meta = await readSkillMarkdownMeta(mdPath)
      const name = meta.name || entry.name
      if (!name) return null
      return {
        name,
        source: 'global',
        path: mdPath,
        description: meta.description,
      }
    }))

  return skills.filter((skill): skill is SkillSuggestion => Boolean(skill))
}

async function readSkillMarkdownMeta(filePath: string) {
  try {
    const raw = await fs.readFile(filePath, 'utf8')
    return {
      name: readFrontmatterValue(raw, 'name') || basename(filePath),
      description: readFrontmatterValue(raw, 'description'),
    }
  } catch {
    return { name: '', description: undefined }
  }
}

function readFrontmatterValue(raw: string, key: string) {
  const match = raw.match(new RegExp(`^${key}:\\s*['"]?([^'"\\n]+)['"]?`, 'm'))
  return match?.[1]?.trim()
}

type GitignoreRule = {
  pattern: string
  negated: boolean
  directoryOnly: boolean
  anchored: boolean
}

async function readGitignore(projectPath: string): Promise<GitignoreRule[]> {
  try {
    const raw = await fs.readFile(join(projectPath, '.gitignore'), 'utf8')
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
      .map(parseGitignoreRule)
      .filter((rule): rule is GitignoreRule => Boolean(rule))
  } catch {
    return []
  }
}

function parseGitignoreRule(line: string): GitignoreRule | null {
  const negated = line.startsWith('!')
  let pattern = negated ? line.slice(1) : line
  if (!pattern) return null

  const anchored = pattern.startsWith('/')
  if (anchored) pattern = pattern.slice(1)

  const directoryOnly = pattern.endsWith('/')
  if (directoryOnly) pattern = pattern.slice(0, -1)
  if (!pattern) return null

  return { pattern, negated, directoryOnly, anchored }
}

function isIgnored(path: string, isDirectory: boolean, rules: GitignoreRule[]) {
  let ignored = false
  const normalizedPath = path.split('\\').join('/')

  for (const rule of rules) {
    if (rule.directoryOnly && !isDirectory && !normalizedPath.startsWith(`${rule.pattern}/`)) continue
    if (!matchesGitignoreRule(normalizedPath, isDirectory, rule)) continue
    ignored = !rule.negated
  }

  return ignored
}

function matchesGitignoreRule(path: string, isDirectory: boolean, rule: GitignoreRule) {
  const pattern = rule.pattern
  if (rule.anchored) {
    return matchPathPattern(path, pattern) || (rule.directoryOnly && (path === pattern || path.startsWith(`${pattern}/`)))
  }

  if (!pattern.includes('/')) {
    return path.split('/').some((part, index, parts) => {
      if (!matchSegment(part, pattern)) return false
      return !rule.directoryOnly || isDirectory || index < parts.length - 1
    })
  }

  return matchPathPattern(path, pattern) || path.endsWith(`/${pattern}`) || path.includes(`/${pattern}/`)
}

function matchPathPattern(path: string, pattern: string) {
  return path === pattern || path.startsWith(`${pattern}/`) || globToRegExp(pattern).test(path)
}

function matchSegment(value: string, pattern: string) {
  return globToRegExp(pattern).test(value)
}

function globToRegExp(pattern: string) {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')
  return new RegExp(`^${escaped}$`)
}
