export interface Workspace {
  id: string
  name: string
  path: string
  createdAt: string
}

export type ThemePreference = 'system' | 'light' | 'dark'

export interface WorkspaceSettings {
  name: string
  description: string
  agentsMd: string
  theme: ThemePreference
  timezone: string
}

const WORKSPACES_KEY = 'pai.workspaces'
const ACTIVE_WORKSPACE_KEY = 'pai.activeWorkspaceId'

export function loadWorkspaces(): Workspace[] {
  try {
    const stored = localStorage.getItem(WORKSPACES_KEY)
    if (!stored) return []
    const parsed = JSON.parse(stored)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isWorkspace)
  } catch {
    return []
  }
}

export function saveWorkspaces(workspaces: Workspace[]): void {
  localStorage.setItem(WORKSPACES_KEY, JSON.stringify(workspaces))
}

export function loadActiveWorkspaceId(): string | null {
  try {
    return localStorage.getItem(ACTIVE_WORKSPACE_KEY)
  } catch {
    return null
  }
}

export function saveActiveWorkspaceId(id: string | null): void {
  if (id) {
    localStorage.setItem(ACTIVE_WORKSPACE_KEY, id)
  } else {
    localStorage.removeItem(ACTIVE_WORKSPACE_KEY)
  }
}

export function createWorkspace(name: string, path: string): Workspace {
  return {
    id: crypto.randomUUID(),
    name,
    path,
    createdAt: new Date().toISOString(),
  }
}

function isWorkspace(value: unknown): value is Workspace {
  if (!value || typeof value !== 'object') return false
  const w = value as Workspace
  return (
    typeof w.id === 'string' &&
    typeof w.name === 'string' &&
    typeof w.path === 'string' &&
    typeof w.createdAt === 'string'
  )
}
