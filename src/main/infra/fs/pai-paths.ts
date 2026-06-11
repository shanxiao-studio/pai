import { createHash } from 'crypto'
import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { parse } from 'smol-toml'

type JsonRecord = Record<string, unknown>

export function paiDataRoot() {
  return process.env.PAI_DATA_HOME || join(homedir(), '.pai')
}

export function globalConfigPath() {
  return join(paiDataRoot(), 'config.toml')
}

export function stableId(value: string) {
  return createHash('sha256').update(value).digest('hex').slice(0, 12)
}

export function workspaceId(workspacePath: string) {
  return stableId(workspacePath)
}

export function projectId(projectPath: string) {
  return stableId(projectPath)
}

export function workspaceDir(workspacePath: string) {
  return join(paiDataRoot(), 'workspaces', workspaceId(workspacePath))
}

export function workspaceConfigPath(workspacePath: string) {
  return join(workspaceDir(workspacePath), 'workspace.toml')
}

export function projectDir(projectPath: string) {
  return join(workspaceDirForProject(projectPath), 'projects', projectId(projectPath))
}

export function paiConfigPath(projectPath: string) {
  return join(projectDir(projectPath), 'project.toml')
}

export function dotagentsConfigPath(projectPath: string) {
  return join(projectDir(projectPath), 'agents.toml')
}

export function projectAgentsMdPath(projectPath: string) {
  return join(projectPath, 'AGENTS.md')
}

export function threadPath(projectPath: string, id: string) {
  return join(projectDir(projectPath), 'threads', `${safeFileName(id)}.toml`)
}

export function threadsDir(projectPath: string) {
  return join(projectDir(projectPath), 'threads')
}

export function sessionDir(projectPath: string, sessionId: string) {
  return join(projectDir(projectPath), 'sessions', safeFileName(sessionId))
}

export function sessionsDir(projectPath: string) {
  return join(projectDir(projectPath), 'sessions')
}

export function transcriptSourcePath(projectPath: string, sessionId: string) {
  return join(sessionDir(projectPath, sessionId), 'transcript-source.json')
}

export function paiRuntimeDir(projectPath: string) {
  return join(projectDir(projectPath), 'runtime')
}

export function orchestratorStatePath(projectPath: string) {
  return join(paiRuntimeDir(projectPath), 'orchestrator-state.json')
}

export function issueSessionId(issueId: string) {
  return issueId.startsWith('issue-') ? issueId : `issue-${issueId}`
}

export function safeFileName(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'item'
}

function workspaceDirForProject(projectPath: string) {
  const mappedWorkspaceId = readProjectWorkspaceMap()[projectId(projectPath)]
  return join(paiDataRoot(), 'workspaces', mappedWorkspaceId || workspaceId(dirname(projectPath)))
}

function readProjectWorkspaceMap(): Record<string, string> {
  const configPath = globalConfigPath()
  if (!existsSync(configPath)) return {}

  try {
    const config = parse(readFileSync(configPath, 'utf8')) as JsonRecord
    const map = isRecord(config.project_workspaces) ? config.project_workspaces : {}
    return Object.fromEntries(
      Object.entries(map)
        .filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    )
  } catch {
    return {}
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
