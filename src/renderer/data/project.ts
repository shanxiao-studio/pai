export type IssueStatus = 'backlog' | 'todo' | 'in_progress' | 'done'
export type IssuePriority = 'urgent' | 'high' | 'medium' | 'low' | 'none'

export interface Issue {
  id: string
  title: string
  status: IssueStatus
  priority: IssuePriority
  labels: string[]
  detail: string
  attributes: Record<string, string>
}

export interface ProjectConfig {
  name: string
  description: string
  slug: string
  path?: string
  status: IssueStatus
  githubLink: string
  labels: string[]
  agentsMd: string
}

export interface DotagentsConfig {
  version: number
  gitignore: boolean
  agents: string[]
  skills: DotagentsSkill[]
  mcp: DotagentsMcp[]
  hooks: DotagentsHook[]
  exists: boolean
}

export interface DotagentsSkill {
  name: string
  source: string
}

export interface DotagentsMcp {
  name: string
  command?: string
  args: string[]
  env: string[]
  url?: string
  headers: Record<string, string>
}

export interface DotagentsHook {
  event: string
  matcher?: string
  command: string
}
