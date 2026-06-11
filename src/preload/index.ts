import { contextBridge, ipcRenderer } from 'electron'

type DotagentsConfig = {
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

contextBridge.exposeInMainWorld('electronAPI', {
  openFolder: () => ipcRenderer.invoke('dialog:openFolder'),
  selectAttachments: (existing: ChatAttachment[]) => ipcRenderer.invoke('dialog:selectAttachments', existing) as Promise<{ accepted: ChatAttachment[]; rejected: RejectedAttachment[] }>,
  readAttachmentPreview: (path: string) => ipcRenderer.invoke('attachment:readPreview', path) as Promise<string | null>,
  getPath: (name: string) => ipcRenderer.invoke('app:getPath', name),
  importProject: () => ipcRenderer.invoke('project:importFolder'),
  createWorkspace: (name: string, parentPath: string) => ipcRenderer.invoke('workspace:create', { name, parentPath }),
  readConfig: (folderPath: string) => ipcRenderer.invoke('workspace:readConfig', folderPath),
  readWorkspaceSettings: (workspacePath: string) => ipcRenderer.invoke('workspace:readSettings', workspacePath),
  writeWorkspaceSettings: (workspacePath: string, settings: { name: string; description: string; agentsMd: string; theme: string; timezone: string }) =>
    ipcRenderer.invoke('workspace:writeSettings', workspacePath, settings),
  watchWorkspace: async (workspacePath: string, callback: (data: { workspacePath: string }) => void) => {
    const watchId = await ipcRenderer.invoke('workspace:watch', workspacePath)
    const handler = (_event: Electron.IpcRendererEvent, data: { workspacePath: string }) => callback(data)
    ipcRenderer.on('workspace:changed', handler)
    return () => {
      ipcRenderer.removeListener('workspace:changed', handler)
      void ipcRenderer.invoke('fileWatch:unwatch', watchId)
    }
  },
  addProjectToConfig: (workspacePath: string, projectPath: string) =>
    ipcRenderer.invoke('workspace:addProjectToConfig', workspacePath, projectPath),
  removeProjectFromConfig: (workspacePath: string, projectPath: string) =>
    ipcRenderer.invoke('workspace:removeProjectFromConfig', workspacePath, projectPath),
  detectAgents: () => ipcRenderer.invoke('agent:detect'),
  listModels: (agentKind: string) => ipcRenderer.invoke('agent:listModels', agentKind),
  readAgentConfig: (projectPath: string) => ipcRenderer.invoke('project:readAgentConfig', projectPath),
  writeAgentConfig: (projectPath: string, config: { kind: string; model: string; thinking: string }) =>
    ipcRenderer.invoke('project:writeAgentConfig', projectPath, config),
  writeOverviewConfig: (projectPath: string, config: { name: string; description: string; status: string; githubLink: string; labels: string[]; agentsMd: string }) =>
    ipcRenderer.invoke('project:writeOverviewConfig', projectPath, config),
  watchProject: async (projectPath: string, callback: (data: { projectPath: string }) => void) => {
    const watchId = await ipcRenderer.invoke('project:watch', projectPath)
    const handler = (_event: Electron.IpcRendererEvent, data: { projectPath: string }) => callback(data)
    ipcRenderer.on('project:changed', handler)
    return () => {
      ipcRenderer.removeListener('project:changed', handler)
      void ipcRenderer.invoke('fileWatch:unwatch', watchId)
    }
  },
  readDotagentsConfig: (projectPath: string) => ipcRenderer.invoke('project:readDotagentsConfig', projectPath),
  writeDotagentsConfig: (projectPath: string, config: DotagentsConfig) =>
    ipcRenderer.invoke('project:writeDotagentsConfig', projectPath, config),
  readSessions: (projectPath: string) => ipcRenderer.invoke('project:readSessions', projectPath),
  writeSessions: (projectPath: string, sessions: Array<{ id: string; name: string; createdAt: string; model?: string; archived?: boolean }>) =>
    ipcRenderer.invoke('project:writeSessions', projectPath, sessions),
  readIssues: (projectPath: string) => ipcRenderer.invoke('project:readIssues', projectPath),
  writeIssues: (projectPath: string, issues: Array<{ id: string; title: string; status: string; priority?: string; labels?: string[]; detail: string; attributes: Record<string, string> }>) =>
    ipcRenderer.invoke('project:writeIssues', projectPath, issues),
  moveIssue: (params: { fromProjectPath: string; toProjectPath: string; issueId: string }) =>
    ipcRenderer.invoke('project:moveIssue', params),
  onProjectIssuesChanged: (callback: (data: { projectPath: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { projectPath: string }) => callback(data)
    ipcRenderer.on('project:issuesChanged', handler)
    return () => ipcRenderer.removeListener('project:issuesChanged', handler)
  },
  readIssueLogs: (projectPath: string, issueId: string) => ipcRenderer.invoke('project:readIssueLogs', projectPath, issueId),
  appendIssueLog: (projectPath: string, issueId: string, entry: { role: string; content: string; thinking?: string; parts?: unknown[]; stream?: string }) =>
    ipcRenderer.invoke('project:appendIssueLog', projectPath, issueId, entry),
  readChatLogs: (projectPath: string, sessionId: string) => ipcRenderer.invoke('project:readChatLogs', projectPath, sessionId),
  appendChatLog: (projectPath: string, sessionId: string, msg: { role: string; content: string; thinking?: string; parts?: unknown[] }) =>
    ipcRenderer.invoke('project:appendChatLog', projectPath, sessionId, msg),
  getEngineSnapshot: () => ipcRenderer.invoke('engine:snapshot'),
  startChat: (params: {
    agentKind: string
    model: string
    thinking: string
    message: string
    userMessage?: string
    attachments?: ChatAttachment[]
    workspacePath: string
    sessionId?: string
  }) => ipcRenderer.invoke('agent:chat', params),
  getAgentStatus: (sessionId: string) => ipcRenderer.invoke('agent:status', sessionId),
  cancelChat: (sessionId: string) => ipcRenderer.invoke('agent:cancel', sessionId),
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
  }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: {
      sessionId: string
      text: string
      stream?: string
      threadId?: string
      turnId?: string
      parts?: unknown[]
      source?: string
      agentKind?: string
      path?: string
    }) =>
      callback(data)
    ipcRenderer.on('agent:output', handler)
    return () => ipcRenderer.removeListener('agent:output', handler)
  },
  onAgentDone: (callback: (data: { sessionId: string; exitCode: number | null; error?: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { sessionId: string; exitCode: number | null; error?: string }) =>
      callback(data)
    ipcRenderer.on('agent:done', handler)
    return () => ipcRenderer.removeListener('agent:done', handler)
  },
  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  closeWindow: () => ipcRenderer.invoke('window:close'),
  toggleMaximize: () => ipcRenderer.invoke('window:toggleMaximize'),
})
