import type { WebContents } from 'electron'
import { AppEventBus } from '../core/app-event-bus'
import { appendAgentOutputEvent, createAssistantMessageAccumulator, finalizeAssistantMessage, hasAssistantMessageContent } from '../core/agent-output-aggregation'
import { type TranscriptSourceMeta } from '../core/agent-transcript'
import { AgentDoneEvent, AgentOutputEvent, AgentRunInput, DotagentsConfig, EngineSnapshot, ProjectIssue, WorkspaceSettings } from '../core/models'
import { AgentRegistry } from '../infra/agents/agent-registry'
import { AgentRuntime } from '../infra/agents/agent-runtime'
import { FileWatchService } from '../infra/fs/file-watch-service'
import { PaiStore } from '../infra/fs/pai-store'
import { IssueOrchestrator } from './issue-orchestrator'

export class PaiApplication {
  constructor(
    private readonly store: PaiStore,
    private readonly registry: AgentRegistry,
    private readonly runtime: AgentRuntime,
    private readonly watches: FileWatchService,
    private readonly events: AppEventBus,
    private readonly orchestrator?: IssueOrchestrator,
  ) {}

  createWorkspace(name: string, parentPath: string) {
    return this.store.createWorkspace(name, parentPath)
  }

  readWorkspaceProjects(workspacePath: string) {
    return this.store.readWorkspaceProjects(workspacePath).then(async (projects) => {
      await Promise.all(projects.map((project) => this.hydrateProject(project.path)))
      return projects
    })
  }

  addProjectToWorkspace(workspacePath: string, projectPath: string) {
    return this.store.addProjectToWorkspace(workspacePath, projectPath)
  }

  removeProjectFromWorkspace(workspacePath: string, projectPath: string) {
    return this.store.removeProjectFromWorkspace(workspacePath, projectPath)
  }

  readWorkspaceSettings(workspacePath: string) {
    return this.store.readWorkspaceSettings(workspacePath)
  }

  async writeWorkspaceSettings(workspacePath: string, settings: WorkspaceSettings) {
    const saved = await this.store.writeWorkspaceSettings(workspacePath, settings)
    this.events.emit({ type: 'workspace.changed', workspacePath })
    return saved
  }

  inspectProjectFolder(projectPath: string) {
    return this.store.inspectProjectFolder(projectPath).then(async (project) => {
      await this.hydrateProject(project.path)
      return project
    })
  }

  watchWorkspace(sender: WebContents, workspacePath: string) {
    return this.watches.watchWorkspace(sender, workspacePath)
  }

  watchProject(sender: WebContents, projectPath: string) {
    return this.watches.watchProject(sender, projectPath)
  }

  unwatch(watchId: string) {
    this.watches.unwatch(watchId)
  }

  readAgentConfig(projectPath: string) {
    return this.store.readAgentConfig(projectPath)
  }

  writeAgentConfig(projectPath: string, config: { kind: string; model: string; thinking: string }) {
    return this.store.writeAgentConfig(projectPath, config)
  }

  writeOverviewConfig(projectPath: string, config: { name: string; description: string; status: string; githubLink: string; labels: string[]; agentsMd: string }) {
    return this.store.writeOverviewConfig(projectPath, config)
  }

  readDotagentsConfig(projectPath: string) {
    return this.store.readDotagentsConfig(projectPath)
  }

  writeDotagentsConfig(projectPath: string, config: DotagentsConfig) {
    return this.store.writeDotagentsConfig(projectPath, config)
  }

  readSessions(projectPath: string) {
    return this.store.readSessions(projectPath)
  }

  writeSessions(projectPath: string, sessions: Array<{ id: string; name: string; createdAt: string; model?: string; archived?: boolean }>) {
    return this.store.writeSessions(projectPath, sessions)
  }

  readIssues(projectPath: string) {
    return this.store.readIssues(projectPath)
  }

  async writeIssues(projectPath: string, issues: ProjectIssue[]) {
    const { issues: savedIssues } = await this.store.writeIssues(projectPath, issues)
    this.events.emit({ type: 'project.issuesChanged', projectPath })
    await this.orchestrator?.onProjectIssuesChanged(projectPath)
    return savedIssues
  }

  async moveIssue(params: { fromProjectPath: string; toProjectPath: string; issueId: string }) {
    await this.store.moveIssue(params)
    this.events.emit({ type: 'project.issuesChanged', projectPath: params.fromProjectPath })
    this.events.emit({ type: 'project.issuesChanged', projectPath: params.toProjectPath })
    await this.orchestrator?.onProjectIssuesChanged(params.fromProjectPath)
    await this.orchestrator?.onProjectIssuesChanged(params.toProjectPath)
  }

  readIssueLogs(projectPath: string, issueId: string) {
    return this.store.readIssueLogs(projectPath, issueId)
  }

  appendIssueLog(projectPath: string, issueId: string, entry: { role: string; content: string; thinking?: string; parts?: unknown[]; stream?: string }) {
    return this.store.appendIssueLog(projectPath, issueId, entry)
  }

  readChatLogs(projectPath: string, sessionId: string) {
    return this.store.readChatLogs(projectPath, sessionId)
  }

  async appendChatLog(projectPath: string, sessionId: string, msg: { role: string; content: string; thinking?: string; parts?: unknown[] }) {
    const line = await this.store.appendChatLog(projectPath, sessionId, msg)
    this.events.emit({ type: 'project.changed', projectPath })
    return line
  }

  writeTranscriptSource(projectPath: string, sessionId: string, source: TranscriptSourceMeta) {
    return this.store.writeTranscriptSource(projectPath, sessionId, source)
  }

  detectAgents() {
    return this.registry.detectAgents()
  }

  listModels(agentKind: string) {
    return this.registry.listModels(agentKind)
  }

  getAgentStatus(sessionId: string) {
    return { running: this.runtime.isRunning(sessionId) }
  }

  cancelChat(sessionId: string) {
    return this.runtime.cancel(sessionId)
  }

  getEngineSnapshot(): EngineSnapshot {
    return this.orchestrator?.getSnapshot() ?? {
      sessions: { running: this.runtime.listRunning() },
      issueRuns: { queued: [], running: [], retrying: [], maxConcurrent: 0, claimedCount: 0 },
    }
  }

  async hydrateProject(projectPath: string) {
    if (!this.orchestrator) return
    await this.orchestrator.hydrateProject(projectPath)
    this.orchestrator.startProject(projectPath)
  }

  async startChat(input: AgentRunInput) {
    const issueId = await this.store.findIssueIdForSession(input.workspacePath, input.sessionId)
    if (!issueId) {
      await this.persistUserMessage(input.workspacePath, input.sessionId, input.source, input.userMessage ?? input.message)
      return this.launchAgent(input)
    }

    await this.store.updateIssueStatus(input.workspacePath, issueId, 'in_progress')
    this.events.emit({ type: 'project.issuesChanged', projectPath: input.workspacePath })

    try {
      await this.persistUserMessage(input.workspacePath, input.sessionId, 'issue', input.userMessage ?? input.message)
      return await this.launchAgent({ ...input, source: 'issue' }, {
        onDone: async (data) => {
          await this.store.updateIssueStatus(input.workspacePath, issueId, data.exitCode === 0 ? 'done' : 'todo')
          this.events.emit({ type: 'project.issuesChanged', projectPath: input.workspacePath })
        },
      })
    } catch (error) {
      await this.store.updateIssueStatus(input.workspacePath, issueId, 'todo')
      this.events.emit({ type: 'project.issuesChanged', projectPath: input.workspacePath })
      throw error
    }
  }

  private launchAgent(
    input: AgentRunInput,
    hooks: {
      onOutput?: (event: AgentOutputEvent) => void
      onDone?: (event: AgentDoneEvent) => void | Promise<void>
    } = {},
  ) {
    let assistantState = createAssistantMessageAccumulator()
    let streamDebounceTimer: ReturnType<typeof setTimeout> | null = null
    let currentSessionId: string | undefined

    const scheduleStreamPersist = () => {
      if (streamDebounceTimer) clearTimeout(streamDebounceTimer)
      streamDebounceTimer = setTimeout(async () => {
        streamDebounceTimer = null
        try {
          const msg = finalizeAssistantMessage(assistantState)
          if (hasAssistantMessageContent(assistantState) && msg.content.trim().length > 0) {
            await this.store.writeStreamingMessage(input.workspacePath, input.sessionId ?? currentSessionId ?? '', {
              role: 'assistant',
              content: msg.content,
              thinking: msg.thinking,
              parts: msg.parts as { type: string; text: string }[],
              stream: msg.stream,
            })
          }
        } catch (error) {
          console.error('[agent] Failed to persist streaming state:', error)
        }
      }, 2000)
    }

    return this.runtime.start(input, {
      onOutput: (event) => {
        currentSessionId = event.sessionId
        void this.store.writeTranscriptSource(input.workspacePath, event.sessionId, {
          agentKind: input.agentKind,
          threadId: event.threadId,
          turnId: event.turnId,
          path: event.path,
          updatedAt: new Date().toISOString(),
        })
        assistantState = appendAgentOutputEvent(assistantState, event)
        scheduleStreamPersist()
        hooks.onOutput?.(event)
        this.emitAgentOutput(event)
      },
      onDone: async (event) => {
        if (streamDebounceTimer) {
          clearTimeout(streamDebounceTimer)
          streamDebounceTimer = null
        }
        try {
          await this.store.clearStreamingMessage(input.workspacePath, input.sessionId ?? currentSessionId ?? event.sessionId)
        } catch (error) {
          console.error('[agent] Failed to clear streaming state:', error)
        }
        if (hasAssistantMessageContent(assistantState) || event.error) {
          const message = finalizeAssistantMessage(assistantState, event.error)
          await this.persistAssistantMessage(input.workspacePath, event.sessionId, input.source, message)
        }
        try {
          await hooks.onDone?.(event)
        } catch (hookError) {
          console.error(`[agent] onDone hook failed for ${event.sessionId}:`, hookError)
        }
        this.emitAgentDone(event)
      },
    })
      .then(async (result) => {
        await this.store.writeTranscriptSource(input.workspacePath, result.sessionId, {
          agentKind: input.agentKind,
          updatedAt: new Date().toISOString(),
        })
        return result
      })
  }

  private async persistUserMessage(
    projectPath: string,
    sessionId: string | undefined,
    source: AgentRunInput['source'] | undefined,
    content: string,
  ) {
    const trimmed = content.trim()
    if (!trimmed) return
    const parts = [{ type: 'text' as const, text: trimmed }]

    if (source === 'issue' || sessionId?.startsWith('issue-')) {
      const issueId = sessionId ? await this.resolveIssueIdForSession(projectPath, sessionId) : null
      if (!issueId) return
      await this.store.appendIssueLog(projectPath, issueId, {
        role: 'user',
        content: trimmed,
        parts,
      })
      return
    }

    await this.store.appendChatLog(projectPath, sessionId ?? 'default', {
      role: 'user',
      content: trimmed,
      parts,
    })
  }

  private async persistAssistantMessage(
    projectPath: string,
    sessionId: string,
    source: AgentRunInput['source'] | undefined,
    message: { content: string; thinking?: string; parts?: unknown[]; stream?: 'stderr' },
  ) {
    if (source === 'issue' || sessionId.startsWith('issue-')) {
      const issueId = await this.resolveIssueIdForSession(projectPath, sessionId)
      if (!issueId) return
      await this.store.appendIssueLog(projectPath, issueId, {
        role: 'assistant',
        content: message.content,
        thinking: message.thinking,
        parts: message.parts,
        stream: message.stream,
      })
      return
    }

    await this.store.appendChatLog(projectPath, sessionId, {
      role: 'assistant',
      content: message.content,
      thinking: message.thinking,
      parts: message.parts,
      stream: message.stream,
    })
  }

  private async resolveIssueIdForSession(projectPath: string, sessionId: string) {
    if (sessionId.startsWith('issue-')) return sessionId.slice('issue-'.length)
    return this.store.findIssueIdForSession(projectPath, sessionId)
  }

  private emitAgentOutput(data: AgentOutputEvent) {
    this.events.emit({ type: 'agent.output', data })
  }

  private emitAgentDone(data: AgentDoneEvent) {
    this.events.emit({ type: 'agent.done', data })
  }
}
