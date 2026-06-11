import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { basename, extname } from 'path'
import { readFile, stat } from 'fs/promises'
import { PaiApplication } from '../application/pai-application'
import { createChatAttachment, filterChatAttachments, MAX_ATTACHMENT_BYTES, type ChatAttachment } from '../core/attachments'
import { AgentRunInput, DotagentsConfig, ProjectIssue, WorkspaceSettings } from '../core/models'
import { listSkillSuggestions, searchProjectFiles } from '../core/prompt-suggestions'

export function registerIpcHandlers(pai: PaiApplication) {
  ipcMain.handle('dialog:openFolder', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle('dialog:selectAttachments', async (event, existing: ChatAttachment[] = []) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    const result = window
      ? await dialog.showOpenDialog(window, { properties: ['openFile', 'multiSelections'] })
      : await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'] })

    if (result.canceled) return { accepted: [], rejected: [] }

    const candidates = await Promise.all(result.filePaths.map(async (filePath) => {
      const info = await stat(filePath)
      return createChatAttachment({
        path: filePath,
        name: basename(filePath),
        size: info.size,
        mimeType: mimeTypeFromPath(filePath),
      })
    }))

    return filterChatAttachments(candidates, existing)
  })

  ipcMain.handle('attachment:readPreview', async (_event, filePath: string) => {
    const mimeType = mimeTypeFromPath(filePath)
    if (!mimeType?.startsWith('image/')) return null

    const info = await stat(filePath)
    if (info.size > MAX_ATTACHMENT_BYTES) return null

    const data = await readFile(filePath)
    return `data:${mimeType};base64,${data.toString('base64')}`
  })

  ipcMain.handle('prompt:listSkills', async (_event, projectPath: string) => {
    const config = await pai.readDotagentsConfig(projectPath)
    return listSkillSuggestions(config.skills)
  })

  ipcMain.handle('prompt:searchFiles', (_event, projectPath: string, query: string) => {
    return searchProjectFiles(projectPath, query)
  })

  ipcMain.handle('app:getPath', (_event, name: string) => {
    return app.getPath(name as Parameters<typeof app.getPath>[0])
  })

  ipcMain.handle('workspace:create', (_event, params: { name: string; parentPath: string }) => {
    return pai.createWorkspace(params.name, params.parentPath)
  })

  ipcMain.handle('workspace:readConfig', (_event, folderPath: string) => {
    return pai.readWorkspaceProjects(folderPath)
  })

  ipcMain.handle('workspace:addProjectToConfig', (_event, workspacePath: string, projectPath: string) => {
    return pai.addProjectToWorkspace(workspacePath, projectPath)
  })

  ipcMain.handle('workspace:removeProjectFromConfig', (_event, workspacePath: string, projectPath: string) => {
    return pai.removeProjectFromWorkspace(workspacePath, projectPath)
  })

  ipcMain.handle('workspace:readSettings', (_event, workspacePath: string) => {
    return pai.readWorkspaceSettings(workspacePath)
  })

  ipcMain.handle('workspace:writeSettings', (_event, workspacePath: string, settings: WorkspaceSettings) => {
    return pai.writeWorkspaceSettings(workspacePath, settings)
  })

  ipcMain.handle('workspace:watch', (event, workspacePath: string) => {
    return pai.watchWorkspace(event.sender, workspacePath)
  })

  ipcMain.handle('project:watch', (event, projectPath: string) => {
    return pai.watchProject(event.sender, projectPath)
  })

  ipcMain.handle('fileWatch:unwatch', (_event, watchId: string) => {
    pai.unwatch(watchId)
  })

  ipcMain.handle('project:importFolder', async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    const result = window
      ? await dialog.showOpenDialog(window, { properties: ['openDirectory'] })
      : await dialog.showOpenDialog({ properties: ['openDirectory'] })

    if (result.canceled || !result.filePaths[0]) return null
    return pai.inspectProjectFolder(result.filePaths[0])
  })

  ipcMain.handle('window:minimize', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize()
  })

  ipcMain.handle('window:close', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close()
  })

  ipcMain.handle('window:toggleMaximize', (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) return false

    if (window.isMaximized()) {
      window.unmaximize()
      return false
    }

    window.maximize()
    return true
  })

  ipcMain.handle('project:readAgentConfig', (_event, projectPath: string) => {
    return pai.readAgentConfig(projectPath)
  })

  ipcMain.handle('project:writeAgentConfig', (_event, projectPath: string, agentConfig: { kind: string; model: string; thinking: string }) => {
    return pai.writeAgentConfig(projectPath, agentConfig)
  })

  ipcMain.handle('project:writeOverviewConfig', (_event, projectPath: string, overview: { name: string; description: string; status: string; githubLink: string; labels: string[]; agentsMd: string }) => {
    return pai.writeOverviewConfig(projectPath, overview)
  })

  ipcMain.handle('project:readDotagentsConfig', (_event, projectPath: string) => {
    return pai.readDotagentsConfig(projectPath)
  })

  ipcMain.handle('project:writeDotagentsConfig', (_event, projectPath: string, config: DotagentsConfig) => {
    return pai.writeDotagentsConfig(projectPath, config)
  })

  ipcMain.handle('project:readSessions', (_event, projectPath: string) => {
    return pai.readSessions(projectPath)
  })

  ipcMain.handle('project:writeSessions', (_event, projectPath: string, sessions: Array<{ id: string; name: string; createdAt: string; model?: string; archived?: boolean }>) => {
    return pai.writeSessions(projectPath, sessions)
  })

  ipcMain.handle('project:readIssues', (_event, projectPath: string) => {
    return pai.readIssues(projectPath)
  })

  ipcMain.handle('project:writeIssues', (_event, projectPath: string, issues: ProjectIssue[]) => {
    return pai.writeIssues(projectPath, issues)
  })

  ipcMain.handle('project:moveIssue', (_event, params: { fromProjectPath: string; toProjectPath: string; issueId: string }) => {
    return pai.moveIssue(params)
  })

  ipcMain.handle('project:readIssueLogs', (_event, projectPath: string, issueId: string) => {
    return pai.readIssueLogs(projectPath, issueId)
  })

  ipcMain.handle('project:appendIssueLog', (_event, projectPath: string, issueId: string, entry: { role: string; content: string; thinking?: string; parts?: unknown[]; stream?: string }) => {
    return pai.appendIssueLog(projectPath, issueId, entry)
  })

  ipcMain.handle('project:readChatLogs', (_event, projectPath: string, sessionId: string) => {
    return pai.readChatLogs(projectPath, sessionId)
  })

  ipcMain.handle('project:appendChatLog', (_event, projectPath: string, sessionId: string, msg: { role: string; content: string; thinking?: string; parts?: unknown[] }) => {
    return pai.appendChatLog(projectPath, sessionId, msg)
  })

  ipcMain.handle('agent:detect', () => {
    return pai.detectAgents()
  })

  ipcMain.handle('agent:listModels', (_event, agentKind: string) => {
    return pai.listModels(agentKind)
  })

  ipcMain.handle('engine:snapshot', () => {
    return pai.getEngineSnapshot()
  })

  ipcMain.handle('agent:status', (_event, sessionId: string) => {
    return pai.getAgentStatus(sessionId)
  })

  ipcMain.handle('agent:chat', (_event, params: AgentRunInput) => {
    return pai.startChat(params)
  })

  ipcMain.handle('agent:cancel', (_event, sessionId: string) => {
    return pai.cancelChat(sessionId)
  })
}

function mimeTypeFromPath(filePath: string) {
  switch (extname(filePath).toLowerCase()) {
    case '.apng':
      return 'image/apng'
    case '.avif':
      return 'image/avif'
    case '.gif':
      return 'image/gif'
    case '.jpeg':
    case '.jpg':
      return 'image/jpeg'
    case '.png':
      return 'image/png'
    case '.svg':
      return 'image/svg+xml'
    case '.webp':
      return 'image/webp'
    default:
      return undefined
  }
}
