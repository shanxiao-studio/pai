import { describe, expect, it, vi } from 'vitest'
import { AppEventBus, PaiAppEvent } from '../../../src/main/core/app-event-bus'
import { AgentRunInput, WorkspaceSettings } from '../../../src/main/core/models'
import { AgentRegistry } from '../../../src/main/infra/agents/agent-registry'
import { AgentRuntime } from '../../../src/main/infra/agents/agent-runtime'
import { FileWatchService } from '../../../src/main/infra/fs/file-watch-service'
import { PaiStore } from '../../../src/main/infra/fs/pai-store'
import { PaiApplication } from '../../../src/main/application/pai-application'
import { IssueOrchestrator } from '../../../src/main/application/issue-orchestrator'

function createHarness() {
  const emitted: PaiAppEvent[] = []
  const events = new AppEventBus()
  events.subscribe((event) => emitted.push(event))

  const store = {
    createWorkspace: vi.fn(async () => ({ name: 'Workspace', path: '/workspace' })),
    readWorkspaceProjects: vi.fn(async () => [{ name: 'Project', path: '/project' }]),
    addProjectToWorkspace: vi.fn(async () => ({ name: 'Project', path: '/project' })),
    removeProjectFromWorkspace: vi.fn(async () => undefined),
    readWorkspaceSettings: vi.fn(async () => ({
      name: 'Workspace',
      description: '',
      agentsMd: '',
      theme: 'system',
      timezone: 'Asia/Shanghai',
    })),
    writeWorkspaceSettings: vi.fn(async (_workspacePath: string, settings: WorkspaceSettings) => settings),
    inspectProjectFolder: vi.fn(async () => ({ name: 'Project', path: '/project' })),
    readAgentConfig: vi.fn(async () => ({ agents: { default: 'codex' } })),
    writeAgentConfig: vi.fn(async (_projectPath: string, config: { kind: string; model: string; thinking: string }) => config),
    writeOverviewConfig: vi.fn(async (_projectPath: string, config: unknown) => config),
    readDotagentsConfig: vi.fn(async () => ({ version: 1, gitignore: true, agents: [], skills: [], mcp: [], hooks: [], exists: false })),
    writeDotagentsConfig: vi.fn(async (_projectPath: string, config: unknown) => config),
    readSessions: vi.fn(async () => [{ id: 'session-1', name: 'Session', createdAt: '2026-06-07T00:00:00.000Z' }]),
    writeSessions: vi.fn(async (_projectPath: string, sessions: unknown[]) => sessions),
    readIssues: vi.fn(async () => []),
    writeIssues: vi.fn(async (_projectPath: string, issues: unknown[]) => ({ issues, enteredTodo: [] })),
    moveIssue: vi.fn(async () => undefined),
    readIssueLogs: vi.fn(async () => [{ type: 'agent', content: 'log' }]),
    appendIssueLog: vi.fn(async () => 'issue-log-line'),
    readChatLogs: vi.fn(async () => [{ role: 'user', content: 'hello' }]),
    appendChatLog: vi.fn(async () => 'chat-log-line'),
    findIssueIdForSession: vi.fn(async () => null as string | null),
    updateIssueStatus: vi.fn(async () => undefined),
  }

  const runtime: AgentRuntime = {
    isRunning: vi.fn(() => false),
    listRunning: vi.fn(() => ['chat-session']),
    cancel: vi.fn(() => true),
    start: vi.fn(async (input: AgentRunInput) => ({ sessionId: input.sessionId ?? 'generated-session' })),
  }

  const registry = {
    detectAgents: vi.fn(async () => [{ kind: 'codex', command: 'codex', version: '1.0.0', available: true }]),
    listModels: vi.fn(async () => ['gpt-5']),
  }

  const watches = {
    watchWorkspace: vi.fn(() => 'workspace-watch'),
    watchProject: vi.fn(() => 'project-watch'),
    unwatch: vi.fn(),
  }

  const orchestrator = {
    onProjectIssuesChanged: vi.fn(async () => undefined),
    getSnapshot: vi.fn(() => ({
      sessions: { running: ['chat-session'] },
      issueRuns: { queued: [], running: [], retrying: [], maxConcurrent: 1, claimedCount: 0 },
    })),
    hydrateProject: vi.fn(async () => undefined),
    startProject: vi.fn(() => undefined),
  }

  const app = new PaiApplication(
    store as unknown as PaiStore,
    registry as unknown as AgentRegistry,
    runtime,
    watches as unknown as FileWatchService,
    events,
    orchestrator as unknown as IssueOrchestrator,
  )

  return { app, emitted, store, runtime, registry, watches, orchestrator }
}

describe('PaiApplication delegations', () => {
  it('forwards workspace, project, config, session, log, registry, watch, and runtime calls', async () => {
    const { app, store, registry, watches, runtime, orchestrator } = createHarness()
    const sender = { isDestroyed: () => false, once: vi.fn() }

    await expect(app.createWorkspace('Workspace', '/parent')).resolves.toEqual({ name: 'Workspace', path: '/workspace' })
    await expect(app.readWorkspaceProjects('/workspace')).resolves.toEqual([{ name: 'Project', path: '/project' }])
    await expect(app.addProjectToWorkspace('/workspace', '/project')).resolves.toEqual({ name: 'Project', path: '/project' })
    await app.removeProjectFromWorkspace('/workspace', '/project')
    await expect(app.readWorkspaceSettings('/workspace')).resolves.toMatchObject({ name: 'Workspace' })
    await expect(app.inspectProjectFolder('/project')).resolves.toMatchObject({ name: 'Project' })

    expect(app.watchWorkspace(sender as never, '/workspace')).toBe('workspace-watch')
    expect(app.watchProject(sender as never, '/project')).toBe('project-watch')
    app.unwatch('workspace-watch')

    await expect(app.readAgentConfig('/project')).resolves.toEqual({ agents: { default: 'codex' } })
    await expect(app.writeAgentConfig('/project', { kind: 'codex', model: 'gpt-5', thinking: 'medium' })).resolves.toEqual({
      kind: 'codex',
      model: 'gpt-5',
      thinking: 'medium',
    })
    await expect(app.writeOverviewConfig('/project', {
      name: 'Project',
      description: '',
      status: 'active',
      githubLink: '',
      labels: [],
      agentsMd: '',
    })).resolves.toMatchObject({ name: 'Project' })
    await expect(app.readDotagentsConfig('/project')).resolves.toMatchObject({ version: 1 })
    await expect(app.writeDotagentsConfig('/project', {
      version: 1,
      gitignore: true,
      agents: [],
      skills: [],
      mcp: [],
      hooks: [],
      exists: true,
    })).resolves.toMatchObject({ exists: true })
    await expect(app.readSessions('/project')).resolves.toEqual([{ id: 'session-1', name: 'Session', createdAt: '2026-06-07T00:00:00.000Z' }])
    await expect(app.writeSessions('/project', [])).resolves.toEqual([])
    await expect(app.readIssues('/project')).resolves.toEqual([])
    await expect(app.readIssueLogs('/project', '1')).resolves.toEqual([{ type: 'agent', content: 'log' }])
    await expect(app.appendIssueLog('/project', '1', { type: 'agent', content: 'hello' })).resolves.toBe('issue-log-line')
    await expect(app.readChatLogs('/project', 'session-1')).resolves.toEqual([{ role: 'user', content: 'hello' }])
    await expect(app.appendChatLog('/project', 'session-1', { role: 'user', content: 'hello' })).resolves.toBe('chat-log-line')
    await expect(app.detectAgents()).resolves.toMatchObject([{ kind: 'codex' }])
    await expect(app.listModels('codex')).resolves.toEqual(['gpt-5'])

    ;(runtime.isRunning as ReturnType<typeof vi.fn>).mockReturnValueOnce(true)
    expect(app.getAgentStatus('session-1')).toEqual({ running: true })
    expect(app.cancelChat('session-1')).toBe(true)
    expect(app.getEngineSnapshot()).toMatchObject({
      sessions: { running: ['chat-session'] },
      issueRuns: { queued: [], running: [], retrying: [], maxConcurrent: 1, claimedCount: 0 },
    })

    expect(store.createWorkspace).toHaveBeenCalledWith('Workspace', '/parent')
    expect(orchestrator.hydrateProject).toHaveBeenCalledWith('/project')
    expect(orchestrator.startProject).toHaveBeenCalledWith('/project')
    expect(watches.watchWorkspace).toHaveBeenCalledWith(sender, '/workspace')
    expect(watches.watchProject).toHaveBeenCalledWith(sender, '/project')
    expect(watches.unwatch).toHaveBeenCalledWith('workspace-watch')
    expect(registry.detectAgents).toHaveBeenCalled()
    expect(registry.listModels).toHaveBeenCalledWith('codex')
    expect(runtime.cancel).toHaveBeenCalledWith('session-1')
  })

  it('emits a workspace change after writing workspace settings', async () => {
    const { app, emitted } = createHarness()
    const settings: WorkspaceSettings = {
      name: 'Workspace',
      description: 'Description',
      agentsMd: '# Agents',
      theme: 'dark',
      timezone: 'Asia/Shanghai',
    }

    await expect(app.writeWorkspaceSettings('/workspace', settings)).resolves.toEqual(settings)
    expect(emitted).toEqual([{ type: 'workspace.changed', workspacePath: '/workspace' }])
  })
})

describe('PaiApplication orchestrator integration', () => {
  it('triggers orchestrator on issue writes and moves', async () => {
    const { app, emitted, orchestrator } = createHarness()

    await app.writeIssues('/project', [])
    await app.moveIssue({ fromProjectPath: '/project', toProjectPath: '/other', issueId: '1' })

    expect(orchestrator.onProjectIssuesChanged).toHaveBeenNthCalledWith(1, '/project')
    expect(orchestrator.onProjectIssuesChanged).toHaveBeenNthCalledWith(2, '/project')
    expect(orchestrator.onProjectIssuesChanged).toHaveBeenNthCalledWith(3, '/other')
    expect(emitted).toContainEqual({ type: 'project.issuesChanged', projectPath: '/project' })
    expect(emitted).toContainEqual({ type: 'project.issuesChanged', projectPath: '/other' })
  })
})

describe('PaiApplication chat agents', () => {
  it('starts regular chat sessions through the runtime', async () => {
    const { app, runtime } = createHarness()
    const input: AgentRunInput = {
      agentKind: 'codex',
      model: 'gpt-5',
      thinking: 'medium',
      message: 'hello',
      workspacePath: '/project',
      sessionId: 'chat-1',
    }

    await expect(app.startChat(input)).resolves.toEqual({ sessionId: 'chat-1' })
    expect(runtime.start).toHaveBeenCalledWith(input, expect.objectContaining({
      onOutput: expect.any(Function),
      onDone: expect.any(Function),
    }))
  })
})
