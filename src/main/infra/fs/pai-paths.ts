import { join } from 'path'

export function paiConfigPath(folderPath: string) {
  return join(folderPath, '.pai', 'pai.toml')
}

export function dotagentsConfigPath(folderPath: string) {
  return join(folderPath, '.pai', 'agents.toml')
}

export function threadPath(projectPath: string, id: string) {
  return join(projectPath, '.pai', 'threads', `${safeFileName(id)}.toml`)
}

export function sessionDir(projectPath: string, sessionId: string) {
  return join(projectPath, '.pai', 'sessions', safeFileName(sessionId))
}

export function transcriptSourcePath(projectPath: string, sessionId: string) {
  return join(sessionDir(projectPath, sessionId), 'transcript-source.json')
}

export function paiRuntimeDir(projectPath: string) {
  return join(projectPath, '.pai', 'runtime')
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
