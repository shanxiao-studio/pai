export {}

declare global {
  interface ImportedProject {
    name: string
    description: string
    slug: string
    path: string
    status: 'backlog' | 'todo' | 'in_progress' | 'done'
    githubLink: string
    labels: string[]
    agentsMd: string
  }

  interface DotagentsConfig {
    version: number
    gitignore: boolean
    agents: string[]
    skills: Array<{ name: string; source: string }>
    mcp: Array<{
      name: string
      command?: string
      args: string[]
      env: string[]
      url?: string
      headers: Record<string, string>
    }>
    hooks: Array<{ event: string; matcher?: string; command: string }>
    exists: boolean
  }

  type ChatAttachment = {
    type: 'attachment'
    path: string
    name: string
    size: number
    mimeType?: string
    kind: 'image' | 'file'
  }

  type RejectedAttachment = {
    path: string
    name: string
    size: number
    reason: 'duplicate' | 'too-large' | 'too-many'
  }

  interface Window {
    electronAPI?: {
      openFolder: () => Promise<string | null>
      selectAttachments: (existing: ChatAttachment[]) => Promise<{ accepted: ChatAttachment[]; rejected: RejectedAttachment[] }>
      readAttachmentPreview: (path: string) => Promise<string | null>
      getPath: (name: string) => Promise<string>
      importProject: () => Promise<ImportedProject | null>
      createWorkspace: (name: string, parentPath: string) => Promise<{ name: string; path: string }>
      readConfig: (folderPath: string) => Promise<ImportedProject[]>
      readWorkspaceSettings: (workspacePath: string) => Promise<{ name: string; description: string; agentsMd: string; theme: 'system' | 'light' | 'dark'; timezone: string }>
      writeWorkspaceSettings: (workspacePath: string, settings: { name: string; description: string; agentsMd: string; theme: string; timezone: string }) => Promise<{ name: string; description: string; agentsMd: string; theme: 'system' | 'light' | 'dark'; timezone: string }>
      watchWorkspace: (workspacePath: string, callback: (data: { workspacePath: string }) => void) => Promise<() => void>
      addProjectToConfig: (workspacePath: string, projectPath: string) => Promise<ImportedProject>
      removeProjectFromConfig: (workspacePath: string, projectPath: string) => Promise<void>
      detectAgents: () => Promise<Array<{
        kind: string
        command: string
        version: string | null
        available: boolean
        error?: string
      }>>
      listModels: (agentKind: string) => Promise<string[]>
      readAgentConfig: (projectPath: string) => Promise<Record<string, unknown>>
      writeAgentConfig: (projectPath: string, config: { kind: string; model: string; thinking: string }) => Promise<{ kind: string; model: string; thinking: string }>
      writeOverviewConfig: (projectPath: string, config: { name: string; description: string; status: string; githubLink: string; labels: string[]; agentsMd: string }) => Promise<{ name: string; description: string; status: string; githubLink: string; labels: string[]; agentsMd: string }>
      watchProject: (projectPath: string, callback: (data: { projectPath: string }) => void) => Promise<() => void>
      readDotagentsConfig: (projectPath: string) => Promise<DotagentsConfig>
      writeDotagentsConfig: (projectPath: string, config: DotagentsConfig) => Promise<DotagentsConfig>
      readSessions: (projectPath: string) => Promise<Array<{ id: string; name: string; createdAt: string; model?: string; archived?: boolean }>>
      writeSessions: (projectPath: string, sessions: Array<{ id: string; name: string; createdAt: string; model?: string; archived?: boolean }>) => Promise<Array<{ id: string; name: string; createdAt: string; model?: string; archived?: boolean }>>
      readIssues: (projectPath: string) => Promise<Array<{ id: string; title: string; status: string; priority?: string; labels?: string[]; detail: string; attributes: Record<string, string> }>>
      writeIssues: (projectPath: string, issues: Array<{ id: string; title: string; status: string; priority?: string; labels?: string[]; detail: string; attributes: Record<string, string> }>) => Promise<Array<{ id: string; title: string; status: string; priority?: string; labels?: string[]; detail: string; attributes: Record<string, string> }>>
      moveIssue: (params: { fromProjectPath: string; toProjectPath: string; issueId: string }) => Promise<void>
      onProjectIssuesChanged: (callback: (data: { projectPath: string }) => void) => () => void
      readIssueLogs: (projectPath: string, issueId: string) => Promise<Array<{ timestamp: string; role?: string; type?: string; content: string; thinking?: string; parts?: unknown[]; stream?: string }>>
      appendIssueLog: (projectPath: string, issueId: string, entry: { role: string; content: string; thinking?: string; parts?: unknown[]; stream?: string }) => Promise<string>
      readChatLogs: (projectPath: string, sessionId: string) => Promise<Array<{ timestamp: string; role: string; content: string; thinking?: string; parts?: unknown[] }>>
      appendChatLog: (projectPath: string, sessionId: string, msg: { role: string; content: string; thinking?: string; parts?: unknown[]; stream?: string }) => Promise<string>
      getEngineSnapshot: () => Promise<{
        sessions: { running: string[] }
        issueRuns: {
          queued: Array<{ key: string; projectPath: string; issueId: string; title: string; attempt?: number; lastError?: string | null }>
          running: Array<{
            key: string
            projectPath: string
            issueId: string
            title: string
            startedAt: string
            attempt?: number
            sessionId?: string | null
            threadId?: string | null
            turnId?: string | null
            lastError?: string | null
            tokenUsage?: {
              inputTokens: number
              outputTokens: number
              reasoningOutputTokens: number
              cachedInputTokens: number
              totalTokens: number
            } | null
          }>
          retrying: Array<{
            key: string
            projectPath: string
            issueId: string
            title: string
            attempt?: number
            nextRetryAt?: string | null
            lastError?: string | null
            sessionId?: string | null
            threadId?: string | null
            turnId?: string | null
            tokenUsage?: {
              inputTokens: number
              outputTokens: number
              reasoningOutputTokens: number
              cachedInputTokens: number
              totalTokens: number
            } | null
          }>
          maxConcurrent: number
          claimedCount: number
        }
      }>
      startChat: (params: {
        agentKind: string
        model: string
        thinking: string
        message: string
        userMessage?: string
        attachments?: ChatAttachment[]
        workspacePath: string
        sessionId?: string
      }) => Promise<{ sessionId: string }>
      getAgentStatus: (sessionId: string) => Promise<{ running: boolean }>
      cancelChat: (sessionId: string) => Promise<boolean>
      onAgentOutput: (callback: (data: {
        sessionId: string
        text: string
        stream?: string
        threadId?: string
        turnId?: string
        parts?: unknown[]
        source?: string
        agentKind?: string
        path?: string
      }) => void) => () => void
      onAgentDone: (callback: (data: { sessionId: string; exitCode: number | null; error?: string }) => void) => () => void
      minimizeWindow: () => Promise<void>
      closeWindow: () => Promise<void>
      toggleMaximize: () => Promise<boolean>
    }
  }
}
