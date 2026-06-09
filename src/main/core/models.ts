import type { StoredMessagePart } from './chat-message-parts'

export type ThemePreference = 'system' | 'light' | 'dark'

export type AgentKind = 'codex' | 'pi' | 'claude' | string

export type ProjectIssue = {
  id: string
  title: string
  status: string
  priority?: string
  labels?: string[]
  detail: string
  attributes: Record<string, string>
}

export type WorkspaceSummary = {
  name: string
  path: string
}

export type WorkspaceSettings = {
  name: string
  description: string
  agentsMd: string
  theme: ThemePreference
  timezone: string
}

export type ImportedProject = {
  name: string
  description: string
  slug: string
  path: string
  status: string
  githubLink: string
  labels: string[]
  agentsMd: string
}

export type AgentSettings = {
  kind: string
  model: string
  thinking: string
}

export type ChatSession = {
  id: string
  name: string
  createdAt: string
  model?: string
  archived?: boolean
}

export type DotagentsSkill = {
  name: string
  source: string
}

export type DotagentsMcp = {
  name: string
  command?: string
  args: string[]
  env: string[]
  url?: string
  headers: Record<string, string>
}

export type DotagentsHook = {
  event: string
  matcher?: string
  command: string
}

export type DotagentsConfig = {
  version: number
  gitignore: boolean
  agents: string[]
  skills: DotagentsSkill[]
  mcp: DotagentsMcp[]
  hooks: DotagentsHook[]
  exists: boolean
}

export type AgentInfo = {
  kind: string
  command: string
  version: string | null
  available: boolean
  error?: string
}

export type AgentRunInput = {
  agentKind: string
  model: string
  thinking: string
  message: string
  userMessage?: string
  workspacePath: string
  sessionId?: string
  source?: 'chat' | 'issue'
}

export type AgentTokenUsage = {
  inputTokens: number
  outputTokens: number
  reasoningOutputTokens: number
  cachedInputTokens: number
  totalTokens: number
}

export type AgentOutputEvent = {
  sessionId: string
  text: string
  stream?: 'stderr'
  threadId?: string
  turnId?: string
  parts?: StoredMessagePart[]
  source?: string
  agentKind?: string
  path?: string
}

export type AgentDoneEvent = {
  sessionId: string
  exitCode: number | null
  error?: string
  threadId?: string
  turnId?: string
  tokenUsage?: AgentTokenUsage
}

export type OrchestratorPhase =
  | 'idle'
  | 'queued'
  | 'running'
  | 'retry_waiting'
  | 'completed'
  | 'failed'
  | 'cancelled'

export type IssueRuntimeState = {
  issueId: string
  claimed: boolean
  phase: OrchestratorPhase
  attempt: number
  nextRetryAt: string | null
  lastError: string | null
  sessionId: string | null
  threadId: string | null
  turnId: string | null
  tokenUsage: AgentTokenUsage | null
  updatedAt: string
}

export type IssueRetryConfig = {
  maxAttempts: number
  baseDelayMs: number
  maxDelayMs: number
}

export type IssueOrchestratorConfig = {
  enabled: boolean
  pollIntervalMs: number
  maxConcurrentRuns: number
  retry: IssueRetryConfig
}

export type CodexAppServerConfig = {
  enabled: boolean
  turnTimeoutMs: number
}

export type PaiConfig = {
  orchestrator: IssueOrchestratorConfig
  codexAppServer: CodexAppServerConfig
}

export type OrchestratorSnapshotIssueRun = {
  key: string
  projectPath: string
  issueId: string
  title: string
  startedAt?: string
  attempt?: number
  nextRetryAt?: string | null
  lastError?: string | null
  sessionId?: string | null
  threadId?: string | null
  turnId?: string | null
  tokenUsage?: AgentTokenUsage | null
}

export type EngineSnapshot = {
  sessions: {
    running: string[]
  }
  issueRuns: {
    queued: OrchestratorSnapshotIssueRun[]
    running: Array<OrchestratorSnapshotIssueRun & { startedAt: string }>
    retrying: OrchestratorSnapshotIssueRun[]
    maxConcurrent: number
    claimedCount: number
  }
}

export type JsonRecord = Record<string, unknown>
