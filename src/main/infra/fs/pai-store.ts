import { promises as fs } from 'fs'
import { basename, dirname, join } from 'path'
import { parse, stringify } from 'smol-toml'
import { summarizeMessageParts, type StoredMessagePart } from '../../core/chat-message-parts'
import { findCodexTranscriptPath, findLatestClaudeTranscriptPath, readClaudeTranscriptMessages, readCodexTranscriptMessages, readPiTranscriptMessages, type TranscriptSourceMeta } from '../../core/agent-transcript'
import {
  AgentSettings,
  ChatSession,
  CodexAppServerConfig,
  DotagentsConfig,
  DotagentsHook,
  DotagentsMcp,
  DotagentsSkill,
  ImportedProject,
  IssueOrchestratorConfig,
  IssueRuntimeState,
  JsonRecord,
  PaiConfig,
  ProjectIssue,
  ThemePreference,
  WorkspaceSettings,
  WorkspaceSummary,
} from '../../core/models'
import { InternalWriteTracker } from './internal-write-tracker'
import {
  dotagentsConfigPath,
  globalConfigPath,
  issueSessionId,
  orchestratorStatePath,
  paiConfigPath,
  paiDataRoot,
  paiRuntimeDir,
  projectAgentsMdPath,
  projectDir,
  projectId,
  sessionDir,
  sessionsDir,
  stableId,
  threadPath,
  threadsDir,
  transcriptSourcePath,
  workspaceConfigPath,
  workspaceDir,
  workspaceId,
} from './pai-paths'

export class PaiStore {
  constructor(private readonly writeTracker: InternalWriteTracker) {}

  async createWorkspace(name: string, parentPath: string): Promise<WorkspaceSummary> {
    const trimmedName = name.trim()
    if (!trimmedName || /[/\\:]/.test(trimmedName)) throw new Error('Invalid workspace name')

    const workspacePath = join(parentPath, trimmedName)
    await fs.mkdir(workspacePath, { recursive: true })

    const existing = (await this.readWorkspaceToml(workspacePath)) ?? {}
    const merged = {
      ...existing,
      name: typeof existing.name === 'string' ? existing.name : trimmedName,
      projects: Array.isArray(existing.projects) ? existing.projects : [],
    }
    await this.writeWorkspaceToml(workspacePath, merged)

    return { name: String(merged.name), path: workspacePath }
  }

  async readWorkspaceProjects(workspacePath: string): Promise<ImportedProject[]> {
    const config = await this.readWorkspaceToml(workspacePath)
    const rawProjects = readProjectRefs(config?.projects)
    const paths: string[] = []
    const seen = new Set<string>()

    for (const project of rawProjects) {
      const normalized = await this.normalizeExistingPath(project.path)
      if (!normalized || seen.has(normalized)) continue
      seen.add(normalized)
      paths.push(normalized)
    }

    if (config && rawProjects.length !== paths.length) {
      config.projects = paths.map((path) => ({ path }))
      await this.writeWorkspaceToml(workspacePath, config)
    }

    const projects: ImportedProject[] = []

    for (const projectPath of paths) {
      try {
        await fs.access(join(projectPath, 'package.json'))
        projects.push(await this.inspectProjectFolder(projectPath))
      } catch {
        // Skip deleted or non-package folders.
      }
    }

    return projects
  }

  async addProjectToWorkspace(workspacePath: string, projectPath: string): Promise<ImportedProject> {
    const config = (await this.readWorkspaceToml(workspacePath)) ?? { projects: [] }
    const projects = readProjectRefs(config.projects)
    const normalizedProjectPath = await this.normalizeExistingPath(projectPath) ?? projectPath
    const existingPaths = await Promise.all(projects.map(async (p) => await this.normalizeExistingPath(p.path) ?? p.path))
    const exists = existingPaths.some((path) => path === normalizedProjectPath)
    if (!exists) {
      projects.push({ path: normalizedProjectPath })
      config.projects = projects
      await this.writeWorkspaceToml(workspacePath, config)
    }
    await this.registerProjectWorkspace(workspacePath, normalizedProjectPath)
    return this.inspectProjectFolder(normalizedProjectPath)
  }

  async removeProjectFromWorkspace(workspacePath: string, projectPath: string): Promise<void> {
    const config = await this.readWorkspaceToml(workspacePath)
    if (!config?.projects) return

    const normalizedProjectPath = await this.normalizeExistingPath(projectPath) ?? projectPath
    const keptProjects = []

    for (const project of readProjectRefs(config.projects)) {
      const normalizedPath = await this.normalizeExistingPath(project.path) ?? project.path
      if (normalizedPath !== normalizedProjectPath) keptProjects.push({ path: normalizedPath })
    }

    config.projects = keptProjects
    await this.writeWorkspaceToml(workspacePath, config)
  }

  async readWorkspaceSettings(workspacePath: string): Promise<WorkspaceSettings> {
    const config = (await this.readWorkspaceToml(workspacePath)) ?? {}
    return {
      name: typeof config.name === 'string' ? config.name : basename(workspacePath),
      description: typeof config.description === 'string' ? config.description : '',
      agentsMd: '',
      theme: isTheme(config.theme) ? config.theme : 'system',
      timezone: typeof config.timezone === 'string' ? config.timezone : Intl.DateTimeFormat().resolvedOptions().timeZone,
    }
  }

  async writeWorkspaceSettings(workspacePath: string, settings: WorkspaceSettings): Promise<WorkspaceSettings> {
    const existing = (await this.readWorkspaceToml(workspacePath)) ?? {}
    const merged = {
      ...existing,
      name: settings.name,
      description: settings.description,
      theme: isTheme(settings.theme) ? settings.theme : 'system',
      timezone: settings.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
    }

    await this.writeWorkspaceToml(workspacePath, merged)
    return {
      name: String(merged.name),
      description: String(merged.description),
      agentsMd: '',
      theme: merged.theme as ThemePreference,
      timezone: String(merged.timezone),
    }
  }

  async inspectProjectFolder(folderPath: string): Promise<ImportedProject> {
    const packageJson = await this.readJsonIfExists(join(folderPath, 'package.json'))
    const packageName = typeof packageJson?.name === 'string' ? packageJson.name : ''
    const folderName = basename(folderPath)
    const name = packageName || folderName
    const gitConfig = await this.readTextIfExists(join(folderPath, '.git/config'))
    const gitOriginUrl = parseOriginUrl(gitConfig ?? '')
    const keywords = Array.isArray(packageJson?.keywords) ? packageJson.keywords : []
    const labels = keywords.filter((keyword): keyword is string => typeof keyword === 'string')
    const paiConfig = await this.ensurePaiLayout(folderPath, { name, repositoryUrl: gitOriginUrl })
    const configLabels = Array.isArray(paiConfig.labels)
      ? paiConfig.labels.filter((label): label is string => typeof label === 'string')
      : labels
    const agentsMd = await this.readTextIfExists(projectAgentsMdPath(folderPath))
    const repository = isRecord(paiConfig.repository) ? paiConfig.repository : {}
    const repositoryUrl = typeof repository.url === 'string' ? repository.url : gitOriginUrl

    return {
      name: typeof paiConfig.name === 'string' ? paiConfig.name : name,
      description: typeof paiConfig.description === 'string' ? paiConfig.description : '',
      slug: projectSlug(folderPath, folderName),
      path: folderPath,
      status: normalizeProjectStatus(paiConfig.status),
      githubLink: repositoryUrl,
      labels: configLabels,
      agentsMd: agentsMd ?? '',
    }
  }

  async readAgentConfig(projectPath: string): Promise<JsonRecord> {
    try {
      const raw = await fs.readFile(paiConfigPath(projectPath), 'utf8')
      const config = parse(raw) as JsonRecord
      return withAgentCompatibility(config)
    } catch {
      return withAgentCompatibility(await this.ensurePaiLayout(projectPath))
    }
  }

  readAgentSettings(config: JsonRecord): AgentSettings {
    const agent = isRecord(config.agent) ? config.agent : {}
    return {
      kind: typeof agent.kind === 'string' && agent.kind ? agent.kind : 'codex',
      model: typeof agent.model === 'string' ? agent.model : '',
      thinking: typeof agent.thinking === 'string' && agent.thinking ? agent.thinking : 'medium',
    }
  }

  readPaiConfig(config: JsonRecord): PaiConfig {
    const orchestrator = isRecord(config.issue_orchestrator) ? config.issue_orchestrator : {}
    const retry = isRecord(orchestrator.retry) ? orchestrator.retry : {}
    const codexAppServer = isRecord(config.codex_app_server) ? config.codex_app_server : {}

    return {
      orchestrator: {
        enabled: typeof orchestrator.enabled === 'boolean' ? orchestrator.enabled : true,
        pollIntervalMs: readPositiveNumber(orchestrator.poll_interval_ms, 2000),
        maxConcurrentRuns: readPositiveNumber(orchestrator.max_concurrent_runs, 1),
        retry: {
          maxAttempts: readPositiveNumber(retry.max_attempts, 3),
          baseDelayMs: readPositiveNumber(retry.base_delay_ms, 5000),
          maxDelayMs: readPositiveNumber(retry.max_delay_ms, 60000),
        },
      },
      codexAppServer: {
        enabled: typeof codexAppServer.enabled === 'boolean' ? codexAppServer.enabled : true,
        turnTimeoutMs: readPositiveNumber(codexAppServer.turn_timeout_ms, 3600000),
      },
    }
  }

  async writeAgentConfig(projectPath: string, agentConfig: AgentSettings): Promise<AgentSettings> {
    const existing = await this.ensurePaiLayout(projectPath)
    const agents = isRecord(existing.agents) ? existing.agents : {}
    const enabled = Array.isArray(agents.enabled) ? agents.enabled.filter((value): value is string => typeof value === 'string') : []
    const rawAgentConfig = agents[agentConfig.kind]
    const existingAgentConfig: JsonRecord = isRecord(rawAgentConfig) ? rawAgentConfig : {}
    const merged = {
      ...existing,
      agents: {
        ...agents,
        default: agentConfig.kind,
        enabled: enabled.includes(agentConfig.kind) ? enabled : [...enabled, agentConfig.kind],
        [agentConfig.kind]: {
          ...existingAgentConfig,
          model: agentConfig.model,
          thinking: agentConfig.thinking,
        },
      },
    }
    await this.writePaiConfig(projectPath, merged)
    return agentConfig
  }

  async writeOverviewConfig(
    projectPath: string,
    overview: { name: string; description: string; status: string; githubLink: string; labels: string[]; agentsMd: string },
  ) {
    const existing = await this.ensurePaiLayout(projectPath)
    const repository = isRecord(existing.repository) ? existing.repository : {}
    const merged = {
      ...existing,
      name: overview.name,
      description: overview.description,
      status: normalizeProjectStatus(overview.status),
      labels: overview.labels,
      repository: {
        ...repository,
        url: overview.githubLink,
      },
    }

    await this.writePaiConfig(projectPath, merged)
    await this.writeTextFile(projectAgentsMdPath(projectPath), overview.agentsMd)
    return overview
  }

  async readDotagentsConfig(projectPath: string): Promise<DotagentsConfig> {
    const existing = await this.readDotagentsRaw(projectPath)
    return normalizeDotagentsConfig(existing ?? {}, Boolean(existing))
  }

  async writeDotagentsConfig(projectPath: string, config: DotagentsConfig): Promise<DotagentsConfig> {
    const existing = await this.readDotagentsRaw(projectPath)
    const normalized = normalizeDotagentsConfig({
      ...(existing ?? {}),
      version: config.version,
      gitignore: config.gitignore,
      agents: config.agents,
      skills: config.skills,
      mcp: config.mcp,
      hooks: config.hooks,
    }, true)

    await this.ensurePaiDataDirs(projectPath)
    await fs.mkdir(join(projectDir(projectPath), '.agents', 'skills'), { recursive: true })
    await this.writeTextFile(dotagentsConfigPath(projectPath), stringify(prepareDotagentsForWrite(normalized)))
    return normalized
  }

  async readSessions(projectPath: string): Promise<ChatSession[]> {
    const threads = await this.readThreads(projectPath, 'chat')
    return threads.map((thread) => ({
      id: String(thread.id),
      name: typeof thread.title === 'string' ? thread.title : String(thread.id),
      createdAt: typeof thread.created_at === 'string' ? thread.created_at : new Date().toISOString(),
      model: typeof thread.model === 'string' ? thread.model : undefined,
      archived: thread.status === 'archived',
    }))
  }

  async writeSessions(projectPath: string, sessions: ChatSession[]): Promise<ChatSession[]> {
    await this.ensurePaiLayout(projectPath)
    const existingChatThreads = await this.readThreads(projectPath, 'chat')
    const keepIds = new Set(sessions.map((session) => session.id))

    await Promise.all(
      existingChatThreads
        .filter((thread) => !keepIds.has(String(thread.id)))
        .map((thread) => this.deleteThread(projectPath, String(thread.id))),
    )

    await Promise.all(sessions.map((session) => this.writeChatThread(projectPath, session)))
    return sessions
  }

  async readIssues(projectPath: string): Promise<ProjectIssue[]> {
    const threads = await this.readThreads(projectPath, 'issue')
    return threads.map((thread) => ({
      id: String(thread.id),
      title: typeof thread.title === 'string' ? thread.title : String(thread.id),
      status: typeof thread.status === 'string' ? thread.status : 'backlog',
      priority: typeof thread.priority === 'string' ? thread.priority : 'none',
      labels: Array.isArray(thread.labels) ? thread.labels.filter((label): label is string => typeof label === 'string') : [],
      detail: typeof thread.detail === 'string' ? thread.detail : '',
      attributes: isRecord(thread.attributes) ? stringifyRecord(thread.attributes) : {},
    }))
  }

  async writeIssues(projectPath: string, issues: ProjectIssue[]): Promise<{ issues: ProjectIssue[]; enteredTodo: ProjectIssue[] }> {
    await this.ensurePaiLayout(projectPath)
    const existingIssueThreads = await this.readThreads(projectPath, 'issue')
    const previousStatusById = new Map(existingIssueThreads.map((thread) => [String(thread.id), typeof thread.status === 'string' ? thread.status : 'backlog']))
    const keepIds = new Set(issues.map((issue) => issue.id))

    await Promise.all(
      existingIssueThreads
        .filter((thread) => !keepIds.has(String(thread.id)))
        .map((thread) => this.deleteThread(projectPath, String(thread.id))),
    )

    await Promise.all(issues.map((issue) => this.writeIssueThread(projectPath, issue)))
    const enteredTodo = issues.filter((issue) => didEnterTodo(previousStatusById.get(issue.id), issue.status))
    return { issues: await this.readIssues(projectPath), enteredTodo }
  }

  async updateIssueStatus(projectPath: string, issueId: string, status: string): Promise<void> {
    const thread = await this.readTomlIfExists(threadPath(projectPath, issueId))
    if (!thread || thread.type !== 'issue') return
    await this.writeThread(projectPath, issueId, { ...thread, status })
  }

  async findIssueIdForSession(projectPath: string, sessionId: string | undefined): Promise<string | null> {
    if (!sessionId) return null
    const issues = await this.readThreads(projectPath, 'issue')
    const issue = issues.find((thread) => {
      if (String(thread.id) === sessionId) return true
      if (issueSessionId(String(thread.id)) === sessionId) return true
      return Array.isArray(thread.sessions) && thread.sessions.some((session) => String(session) === sessionId)
    })
    return issue ? String(issue.id) : null
  }

  async readIssueLogs(projectPath: string, issueId: string): Promise<JsonRecord[]> {
    const sessionId = issueSessionId(issueId)
    const legacySessionId = `issue-${issueId}`
    const logs = await this.readJsonlLines(join(sessionDir(projectPath, sessionId), 'events.jsonl'))
    const legacyLogs = await this.readJsonlLines(join(sessionDir(projectPath, legacySessionId), 'events.jsonl'))
    const combined = [...legacyLogs, ...logs].sort((a, b) => String(a.timestamp ?? '').localeCompare(String(b.timestamp ?? '')))
    return this.hydrateTranscriptHistory(projectPath, sessionId, combined)
  }

  async appendIssueLog(projectPath: string, issueId: string, entry: { role: string; content: string; thinking?: string; parts?: unknown[]; stream?: string }): Promise<string> {
    await this.ensureSession(projectPath, issueSessionId(issueId), {
      threadId: issueId,
      agent: 'unknown',
      kind: 'issue',
    })
    const line = JSON.stringify({ timestamp: new Date().toISOString(), ...entry }) + '\n'
    await this.appendTextFile(join(sessionDir(projectPath, issueSessionId(issueId)), 'events.jsonl'), line)
    return line
  }

  async moveIssue(params: { fromProjectPath: string; toProjectPath: string; issueId: string }): Promise<void> {
    const { fromProjectPath, toProjectPath, issueId } = params
    if (fromProjectPath === toProjectPath) return

    await this.ensurePaiLayout(fromProjectPath)
    await this.ensurePaiLayout(toProjectPath)

    const threadSource = threadPath(fromProjectPath, issueId)
    const threadTarget = threadPath(toProjectPath, issueId)
    const sessionId = issueSessionId(issueId)
    const sessionSource = sessionDir(fromProjectPath, sessionId)
    const sessionTarget = sessionDir(toProjectPath, sessionId)

    await this.ensurePaiDataDirs(toProjectPath)

    this.writeTracker.mark(threadTarget)
    await fs.copyFile(threadSource, threadTarget)
    await this.copyDirectory(sessionSource, sessionTarget)

    await this.unlinkFile(threadSource)
    await this.removeDirectory(sessionSource)
  }

  private static STREAM_FILE = 'messages.jsonl.stream'

  async writeStreamingMessage(projectPath: string, sessionId: string, msg: { role: string; content: string; thinking?: string; parts?: unknown[]; stream?: string }): Promise<void> {
    await this.ensureSession(projectPath, sessionId, { threadId: sessionId, agent: 'unknown', kind: 'chat' })
    const data = JSON.stringify({ timestamp: new Date().toISOString(), ...msg, _streaming: true }) + '\n'
    await this.writeTextFile(join(sessionDir(projectPath, sessionId), PaiStore.STREAM_FILE), data)
  }

  async clearStreamingMessage(projectPath: string, sessionId: string): Promise<void> {
    const filePath = join(sessionDir(projectPath, sessionId), PaiStore.STREAM_FILE)
    try { await this.unlinkFile(filePath) }
    catch { /* file may not exist */ }
  }

  async readChatLogs(projectPath: string, sessionId: string): Promise<JsonRecord[]> {
    const logs = await this.readJsonlLines(join(sessionDir(projectPath, sessionId), 'messages.jsonl'))
    const result = await this.hydrateTranscriptHistory(projectPath, sessionId, logs)
    const streamMsg = await this.readStreamingMessage(projectPath, sessionId)
    if (streamMsg) result.push(streamMsg)
    return result
  }

  async appendChatLog(projectPath: string, sessionId: string, msg: { role: string; content: string; thinking?: string; parts?: unknown[]; stream?: string }): Promise<string> {
    await this.ensureSession(projectPath, sessionId, {
      threadId: sessionId,
      agent: 'unknown',
      kind: 'chat',
    })
    const line = JSON.stringify({ timestamp: new Date().toISOString(), ...msg }) + '\n'
    await this.appendTextFile(join(sessionDir(projectPath, sessionId), 'messages.jsonl'), line)
    return line
  }

  private async readStreamingMessage(projectPath: string, sessionId: string): Promise<JsonRecord | null> {
    const streamMsg = await this.readJsonIfExists(join(sessionDir(projectPath, sessionId), PaiStore.STREAM_FILE))
    if (!streamMsg || typeof streamMsg.role !== 'string' || !streamMsg._streaming) return null
    return {
      ...streamMsg,
      role: 'assistant',
      stream: typeof streamMsg.stream === 'string' ? streamMsg.stream : 'stderr',
      content: typeof streamMsg.content === 'string' ? streamMsg.content : '',
      _streaming: true,
      _from_stream_file: true,
    }
  }

  async writeTranscriptSource(projectPath: string, sessionId: string, source: TranscriptSourceMeta) {
    await this.ensureSession(projectPath, sessionId, {
      threadId: sessionId,
      agent: source.agentKind ?? 'unknown',
      kind: sessionId.startsWith('issue-') ? 'issue' : 'chat',
    })
    await this.writeTextFile(transcriptSourcePath(projectPath, sessionId), JSON.stringify(source, null, 2))
  }

  async readIssueRuntimeState(projectPath: string): Promise<Record<string, IssueRuntimeState>> {
    await this.ensurePaiLayout(projectPath)
    const raw = await this.readTextIfExists(orchestratorStatePath(projectPath))
    if (!raw) return {}

    try {
      const parsed = JSON.parse(raw)
      if (!isRecord(parsed)) return {}
      return Object.fromEntries(
        Object.entries(parsed)
          .map(([issueId, value]) => [issueId, normalizeIssueRuntimeState(issueId, value)])
          .filter((entry): entry is [string, IssueRuntimeState] => Boolean(entry[1])),
      )
    } catch {
      return {}
    }
  }

  async writeIssueRuntimeState(projectPath: string, runtimeState: Record<string, IssueRuntimeState>): Promise<void> {
    await this.ensurePaiLayout(projectPath)
    await fs.mkdir(paiRuntimeDir(projectPath), { recursive: true })
    await this.writeTextFile(orchestratorStatePath(projectPath), JSON.stringify(runtimeState, null, 2))
  }

  private async readWorkspaceToml(workspacePath: string): Promise<JsonRecord | null> {
    try {
      const raw = await fs.readFile(workspaceConfigPath(workspacePath), 'utf8')
      return parse(raw) as JsonRecord
    } catch {
      return null
    }
  }

  private async writeWorkspaceToml(workspacePath: string, config: JsonRecord) {
    await fs.mkdir(workspaceDir(workspacePath), { recursive: true })
    await this.writeTextFile(workspaceConfigPath(workspacePath), stringify(config))
  }

  private async registerProjectWorkspace(workspacePath: string, projectPath: string) {
    const existing = await this.readGlobalConfig()
    const projectWorkspaces = isRecord(existing.project_workspaces) ? existing.project_workspaces : {}
    const merged = {
      ...existing,
      project_workspaces: {
        ...projectWorkspaces,
        [projectId(projectPath)]: workspaceId(workspacePath),
      },
    }
    await fs.mkdir(paiDataRoot(), { recursive: true })
    await this.writeTextFile(globalConfigPath(), stringify(merged))
  }

  private async readGlobalConfig(): Promise<JsonRecord> {
    try {
      const raw = await fs.readFile(globalConfigPath(), 'utf8')
      const parsed = parse(raw)
      return isRecord(parsed) ? parsed : {}
    } catch {
      return {}
    }
  }

  private async readDotagentsRaw(projectPath: string) {
    try {
      const raw = await fs.readFile(dotagentsConfigPath(projectPath), 'utf8')
      return parse(raw) as JsonRecord
    } catch (error) {
      if (isMissingFile(error)) return null
      throw error
    }
  }

  private async ensurePaiLayout(projectPath: string, defaults: { name?: string; repositoryUrl?: string } = {}) {
    await this.ensurePaiDataDirs(projectPath)

    const existing = await this.readPaiConfigRaw(projectPath)
    const migrated = normalizePaiConfig(existing, defaults)
    if (JSON.stringify(existing ?? {}) !== JSON.stringify(migrated)) {
      await this.writePaiConfig(projectPath, migrated)
    }

    return migrated
  }

  private async readPaiConfigRaw(projectPath: string) {
    try {
      const raw = await fs.readFile(paiConfigPath(projectPath), 'utf8')
      return parse(raw) as JsonRecord
    } catch {
      return {}
    }
  }

  private async writePaiConfig(projectPath: string, config: JsonRecord) {
    await this.ensurePaiDataDirs(projectPath)
    await this.writeTextFile(paiConfigPath(projectPath), stringify(config))
  }

  private async ensurePaiDataDirs(projectPath: string) {
    await fs.mkdir(threadsDir(projectPath), { recursive: true })
    await fs.mkdir(sessionsDir(projectPath), { recursive: true })
    await fs.mkdir(paiRuntimeDir(projectPath), { recursive: true })
  }

  private async readThreads(projectPath: string, type: 'chat' | 'issue') {
    await this.ensurePaiLayout(projectPath)
    const dir = threadsDir(projectPath)
    const entries = await fs.readdir(dir, { withFileTypes: true })
    const threads = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.toml'))
        .map(async (entry) => {
          try {
            const raw = await fs.readFile(join(dir, entry.name), 'utf8')
            return parse(raw) as JsonRecord
          } catch {
            return null
          }
        }),
    )

    return threads.filter((thread): thread is JsonRecord => Boolean(thread && thread.type === type))
  }

  private async writeChatThread(projectPath: string, session: ChatSession) {
    await this.writeThread(projectPath, session.id, {
      id: session.id,
      type: 'chat',
      title: session.name,
      status: session.archived ? 'archived' : 'open',
      created_at: session.createdAt,
      ...(session.model ? { model: session.model } : {}),
      sessions: [session.id],
    })
    await this.ensureSession(projectPath, session.id, {
      threadId: session.id,
      agent: 'unknown',
      kind: 'chat',
    })
  }

  private async writeIssueThread(projectPath: string, issue: ProjectIssue) {
    await this.writeThread(projectPath, issue.id, {
      id: issue.id,
      type: 'issue',
      title: issue.title,
      status: issue.status,
      priority: issue.priority ?? 'none',
      labels: issue.labels ?? [],
      detail: issue.detail,
      attributes: issue.attributes,
      sessions: [issueSessionId(issue.id)],
    })
  }

  private async writeThread(projectPath: string, id: string, thread: JsonRecord) {
    await this.ensurePaiLayout(projectPath)
    await this.writeTextFile(threadPath(projectPath, id), stringify(thread))
  }

  private async deleteThread(projectPath: string, id: string) {
    try {
      await this.unlinkFile(threadPath(projectPath, id))
    } catch (error) {
      if (!isMissingFile(error)) throw error
    }
  }

  private async ensureSession(projectPath: string, sessionId: string, options: { threadId: string; agent: string; kind: 'chat' | 'issue' }) {
    const dir = sessionDir(projectPath, sessionId)
    await fs.mkdir(join(dir, 'artifacts'), { recursive: true })
    await fs.mkdir(join(dir, 'patches'), { recursive: true })
    await fs.mkdir(join(dir, 'logs'), { recursive: true })

    const metaPath = join(dir, 'session.toml')
    const existing = await this.readTomlIfExists(metaPath)
    if (existing) return

    await this.writeTextFile(metaPath, stringify({
      id: sessionId,
      thread_id: options.threadId,
      thread_type: options.kind,
      agent: options.agent,
      status: 'open',
      started_at: new Date().toISOString(),
    }))
  }

  private async readTomlIfExists(path: string) {
    const text = await this.readTextIfExists(path)
    if (!text) return null

    try {
      return parse(text) as JsonRecord
    } catch {
      return null
    }
  }

  private async readTextIfExists(path: string) {
    try {
      return await fs.readFile(path, 'utf8')
    } catch (error) {
      if (isMissingFile(error)) return null
      throw error
    }
  }

  private async readJsonIfExists(path: string): Promise<JsonRecord | null> {
    const text = await this.readTextIfExists(path)
    if (!text) return null

    try {
      const parsed = JSON.parse(text)
      return isRecord(parsed) ? parsed : null
    } catch {
      return null
    }
  }

  private async readJsonlLines(filePath: string): Promise<JsonRecord[]> {
    try {
      const raw = await fs.readFile(filePath, 'utf8')
      return raw
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          try {
            const value = JSON.parse(line)
            return isRecord(value) ? value : null
          } catch {
            return null
          }
        })
        .filter((value): value is JsonRecord => value !== null)
    } catch {
      return []
    }
  }

  private async hydrateTranscriptHistory(projectPath: string, sessionId: string, logs: JsonRecord[]) {
    const sourceMeta = await this.readTranscriptSource(projectPath, sessionId)
    const transcriptMessages = await this.readTranscriptBackfill(projectPath, sessionId, sourceMeta)
    if (transcriptMessages.length === 0) return dedupeTranscriptLogs(logs)

    return dedupeTranscriptLogs(mergeTranscriptDetailsIntoLogs(logs, transcriptMessages))
  }

  private async readTranscriptSource(projectPath: string, sessionId: string): Promise<TranscriptSourceMeta | null> {
    const value = await this.readJsonIfExists(transcriptSourcePath(projectPath, sessionId))
    return value as TranscriptSourceMeta | null
  }

  private async readTranscriptBackfill(projectPath: string, sessionId: string, sourceMeta: TranscriptSourceMeta | null) {
    const agentKind = sourceMeta?.agentKind
    if (agentKind === 'pi') {
      const piRuntimeDir = join(sessionDir(projectPath, sessionId), 'pi-runtime')
      return readPiTranscriptMessages(piRuntimeDir)
    }

    if (agentKind === 'claude') {
      const claudePath = sourceMeta?.path ?? await findLatestClaudeTranscriptPath(projectPath)
      if (!claudePath) return []
      return readClaudeTranscriptMessages(claudePath)
    }

    if (agentKind === 'codex') {
      const codexPath = sourceMeta?.path ?? await findCodexTranscriptPath(sourceMeta?.threadId)
      if (!codexPath) return []
      return readCodexTranscriptMessages(codexPath, {
        threadId: sourceMeta?.threadId,
        turnId: sourceMeta?.turnId,
      })
    }

    return []
  }

  private async normalizeExistingPath(path: string) {
    try {
      return await fs.realpath(path)
    } catch (error) {
      if (isMissingFile(error)) return null
      throw error
    }
  }

  private async writeTextFile(path: string, data: string) {
    this.writeTracker.mark(path)
    await fs.mkdir(dirname(path), { recursive: true })
    await fs.writeFile(path, data, 'utf8')
  }

  private async appendTextFile(path: string, data: string) {
    this.writeTracker.mark(path)
    await fs.mkdir(dirname(path), { recursive: true })
    await fs.appendFile(path, data, 'utf8')
  }

  private async unlinkFile(path: string) {
    this.writeTracker.mark(path)
    await fs.unlink(path)
  }

  private async copyDirectory(source: string, target: string) {
    await fs.mkdir(target, { recursive: true })
    const entries = await fs.readdir(source, { withFileTypes: true })

    await Promise.all(entries.map(async (entry) => {
      const sourcePath = join(source, entry.name)
      const targetPath = join(target, entry.name)

      if (entry.isDirectory()) {
        await this.copyDirectory(sourcePath, targetPath)
        return
      }

      this.writeTracker.mark(targetPath)
      await fs.copyFile(sourcePath, targetPath)
    }))
  }

  private async removeDirectory(path: string) {
    this.writeTracker.mark(path)
    await fs.rm(path, { recursive: true, force: true })
  }
}

function dedupeTranscriptLogs(logs: JsonRecord[]) {
  const sorted = [...logs].sort((left, right) => String(left.timestamp ?? '').localeCompare(String(right.timestamp ?? '')))
  const seen = new Map<string, number>()
  const result: JsonRecord[] = []

  for (const rawEntry of sorted) {
    const entry = normalizeTranscriptLog(rawEntry)
    const role = typeof entry.role === 'string' ? entry.role : typeof entry.type === 'string' ? entry.type : 'assistant'
    if (role !== 'assistant') {
      result.push(entry)
      continue
    }
    const content = typeof entry.content === 'string' ? entry.content.trim() : ''
    const structuredText = Array.isArray(entry.parts) ? getStructuredText(entry.parts) : ''
    const parts = Array.isArray(entry.parts) ? JSON.stringify(entry.parts) : ''
    const key = `${role}::${content || structuredText || parts}`
    if (parts || content || structuredText) {
      let previousIndex = seen.get(key)
      if (previousIndex === undefined && role === 'assistant' && structuredText) {
        const matchingAssistantIndex = result.findIndex((candidate) => {
          if ((candidate.role ?? candidate.type) !== 'assistant') return false
          const candidateContent = typeof candidate.content === 'string' ? candidate.content.trim() : ''
          const candidateStructuredText = Array.isArray(candidate.parts) ? getStructuredText(candidate.parts) : ''
          return (
            candidateContent.length > 0 && (structuredText.includes(candidateContent) || candidateContent.includes(content))
          ) || (
            candidateStructuredText.length > 0 && (structuredText.includes(candidateStructuredText) || candidateStructuredText.includes(structuredText))
          )
        })
        if (matchingAssistantIndex >= 0) previousIndex = matchingAssistantIndex
      }
      if (previousIndex !== undefined) {
        const previous = result[previousIndex]
        if (isMoreCompleteTranscriptEntry(entry, previous)) {
          result[previousIndex] = entry
        }
        continue
      }
      seen.set(key, result.length)
    }
    result.push(entry)
  }

  return result
}

function mergeTranscriptDetailsIntoLogs(logs: JsonRecord[], transcriptMessages: JsonRecord[]) {
  if (logs.length === 0) return []
  const normalizedTranscripts = transcriptMessages.map(normalizeTranscriptLog)
  const usedTranscriptIndexes = new Set<number>()

  return logs.map((rawEntry) => {
    const entry = normalizeTranscriptLog(rawEntry)
    const role = typeof entry.role === 'string' ? entry.role : typeof entry.type === 'string' ? entry.type : 'assistant'
    if (role !== 'assistant') return entry

    const transcriptIndex = findMatchingTranscript(entry, normalizedTranscripts, usedTranscriptIndexes)
    if (transcriptIndex < 0) return entry

    usedTranscriptIndexes.add(transcriptIndex)
    const transcript = normalizedTranscripts[transcriptIndex]
    return mergeTranscriptEntryDetails(entry, transcript)
  })
}

function mergeTranscriptEntryDetails(entry: JsonRecord, transcript: JsonRecord) {
  if (!isMoreCompleteTranscriptEntry(transcript, entry)) return entry
  const entryText = typeof entry.content === 'string' ? entry.content : ''
  const transcriptParts = Array.isArray(transcript.parts) ? transcript.parts : []
  const focusedTranscriptParts = focusTranscriptPartsForContent(transcriptParts, entryText)
  const parts = focusedTranscriptParts.length > 0 ? focusedTranscriptParts : transcriptParts
  const typedParts = parts.filter(isStoredMessagePart)
  const summary = summarizeMessageParts(typedParts)
  const thinking = summary.thinking.trim()
  const hasNonLogPart = parts.some((part) => isRecord(part) && part.type !== 'log')

  return {
    ...entry,
    ...(thinking ? { thinking } : {}),
    parts,
    ...(hasNonLogPart && entry.stream === 'stderr' ? { stream: undefined } : {}),
  }
}

function focusTranscriptPartsForContent(parts: unknown[], content: string) {
  if (!content) return parts
  const textIndex = parts.findIndex((part) => isRecord(part) && part.type === 'text' && part.text === content)
  if (textIndex < 0) return parts

  let start = textIndex
  while (start > 0) {
    const previous = parts[start - 1]
    if (isRecord(previous) && previous.type === 'thinking') {
      start -= 1
      continue
    }
    break
  }
  return parts.slice(start)
}

function findMatchingTranscript(entry: JsonRecord, transcripts: JsonRecord[], usedIndexes: Set<number>) {
  const content = typeof entry.content === 'string' ? entry.content.trim() : ''
  const structuredText = Array.isArray(entry.parts) ? getStructuredText(entry.parts) : ''

  return transcripts.findIndex((candidate, index) => {
    if (usedIndexes.has(index)) return false
    if ((candidate.role ?? candidate.type) !== 'assistant') return false

    const candidateContent = typeof candidate.content === 'string' ? candidate.content.trim() : ''
    const candidateStructuredText = Array.isArray(candidate.parts) ? getStructuredText(candidate.parts) : ''

    if (content && candidateContent && (content.includes(candidateContent) || candidateContent.includes(content))) return true
    if (structuredText && candidateStructuredText && (structuredText.includes(candidateStructuredText) || candidateStructuredText.includes(structuredText))) return true
    if (content && candidateStructuredText && candidateStructuredText.includes(content)) return true
    if (structuredText && candidateContent && structuredText.includes(candidateContent)) return true
    return false
  })
}

function getStructuredText(parts: unknown[]) {
  return parts
    .map((part) => isRecord(part) && typeof part.type === 'string' && (part.type === 'text' || part.type === 'tool-result') && typeof part.text === 'string'
      ? part.text.trim()
      : '')
    .filter(Boolean)
    .join('')
}

function normalizeTranscriptLog(entry: JsonRecord) {
  const role = typeof entry.role === 'string' ? entry.role : typeof entry.type === 'string' ? entry.type : 'assistant'
  if (role !== 'assistant' || !Array.isArray(entry.parts)) return entry

  const parts = collapseRepeatedAssistantParts(entry.parts)
  const hasNonLogPart = parts.some((part) => isRecord(part) && part.type !== 'log')
  if (parts.length === entry.parts.length && (!hasNonLogPart || entry.stream !== 'stderr')) return entry

  const typedParts = parts.filter(isStoredMessagePart)
  const summary = summarizeMessageParts(typedParts)
  const content = summary.content || summary.plainText || (typeof entry.content === 'string' ? entry.content : '')
  const thinking = summary.thinking.trim() || (typeof entry.thinking === 'string' ? entry.thinking : '')
  return {
    ...entry,
    content,
    ...(thinking ? { thinking } : {}),
    parts,
    ...(hasNonLogPart && entry.stream === 'stderr' ? { stream: undefined } : {}),
  }
}

function collapseRepeatedAssistantParts(parts: unknown[]) {
  const result: unknown[] = []
  let index = 0
  while (index < parts.length) {
    const overlap = findRepeatedPartOverlap(result, parts, index)
    if (overlap > 0) {
      index += overlap
      continue
    }
    result.push(parts[index])
    index += 1
  }
  return result
}

function findRepeatedPartOverlap(result: unknown[], parts: unknown[], startIndex: number) {
  const maxSize = Math.min(result.length, parts.length - startIndex)
  for (let size = maxSize; size > 0; size -= 1) {
    const resultStart = result.length - size
    let matched = true
    for (let offset = 0; offset < size; offset += 1) {
      if (!isSameStoredPart(result[resultStart + offset], parts[startIndex + offset])) {
        matched = false
        break
      }
    }
    if (matched && size >= 2) return size
  }
  return 0
}

function isStoredMessagePart(part: unknown): part is StoredMessagePart {
  if (!isRecord(part) || typeof part.type !== 'string') return false
  return ['text', 'thinking', 'tool-call', 'tool-result', 'event', 'log'].includes(part.type)
}

function isSameStoredPart(left: unknown, right: unknown) {
  if (!isRecord(left) || !isRecord(right) || left.type !== right.type) return false
  if (left.type === 'thinking' && right.type === 'thinking') return left.text === right.text
  if (left.type === 'text' && right.type === 'text') return left.text === right.text
  if (left.type === 'tool-call' && right.type === 'tool-call') return left.id === right.id && left.name === right.name
  if (left.type === 'tool-result' && right.type === 'tool-result') {
    return left.id === right.id && left.name === right.name && (left.text ?? '') === (right.text ?? '')
  }
  if (left.type === 'event' && right.type === 'event') return left.name === right.name && (left.text ?? '') === (right.text ?? '')
  if (left.type === 'log' && right.type === 'log') return left.stream === right.stream && left.text === right.text
  return false
}

function isMoreCompleteTranscriptEntry(current: JsonRecord, previous: JsonRecord | undefined) {
  const previousParts = Array.isArray(previous?.parts) ? previous.parts : []
  const currentParts = Array.isArray(current.parts) ? current.parts : []
  if (currentParts.length === 0) return false
  if (previousParts.length === 0) return true

  const previousThinking = typeof previous?.thinking === 'string' && previous.thinking.trim().length > 0
    ? true
    : previousParts.some((part) => isRecord(part) && part.type === 'thinking')
  const currentThinking = typeof current.thinking === 'string' && current.thinking.trim().length > 0
    ? true
    : currentParts.some((part) => isRecord(part) && part.type === 'thinking')
  if (currentThinking && !previousThinking) return true

  const previousToolParts = previousParts.filter((part) => isRecord(part) && (part.type === 'tool-call' || part.type === 'tool-result')).length
  const currentToolParts = currentParts.filter((part) => isRecord(part) && (part.type === 'tool-call' || part.type === 'tool-result')).length
  return currentToolParts > previousToolParts
}

function normalizePaiConfig(existing: JsonRecord, defaults: { name?: string; repositoryUrl?: string }) {
  const legacyAgent = isRecord(existing.agent) ? existing.agent : {}
  const existingAgents = isRecord(existing.agents) ? existing.agents : {}
  const legacyKind = typeof legacyAgent.kind === 'string' ? legacyAgent.kind : ''
  const defaultAgent = typeof existingAgents.default === 'string' ? existingAgents.default : legacyKind || 'codex'
  const enabled = Array.isArray(existingAgents.enabled)
    ? existingAgents.enabled.filter((value): value is string => typeof value === 'string')
    : []
  const enabledAgents = enabled.includes(defaultAgent) ? enabled : [...enabled, defaultAgent]
  const defaultAgentConfig = isRecord(existingAgents[defaultAgent]) ? existingAgents[defaultAgent] : {}
  const repository = isRecord(existing.repository) ? existing.repository : {}
  const orchestrator = isRecord(existing.issue_orchestrator) ? existing.issue_orchestrator : {}
  const retry = isRecord(orchestrator.retry) ? orchestrator.retry : {}
  const codexAppServer = isRecord(existing.codex_app_server) ? existing.codex_app_server : {}
  const normalized: JsonRecord = {
    ...existing,
    version: existing.version ?? 1,
    name: existing.name ?? defaults.name ?? 'project',
    description: typeof existing.description === 'string' ? existing.description : '',
    agents_file: existing.agents_file ?? 'AGENTS.md',
    repository: {
      ...repository,
      url: repository.url ?? defaults.repositoryUrl ?? '',
    },
    issue_orchestrator: {
      enabled: typeof orchestrator.enabled === 'boolean' ? orchestrator.enabled : true,
      poll_interval_ms: readPositiveNumber(orchestrator.poll_interval_ms, 2000),
      max_concurrent_runs: readPositiveNumber(orchestrator.max_concurrent_runs, 1),
      retry: {
        max_attempts: readPositiveNumber(retry.max_attempts, 3),
        base_delay_ms: readPositiveNumber(retry.base_delay_ms, 5000),
        max_delay_ms: readPositiveNumber(retry.max_delay_ms, 60000),
      },
    },
    codex_app_server: {
      enabled: typeof codexAppServer.enabled === 'boolean' ? codexAppServer.enabled : true,
      turn_timeout_ms: readPositiveNumber(codexAppServer.turn_timeout_ms, 3600000),
    },
    agents: {
      ...existingAgents,
      default: defaultAgent,
      enabled: enabledAgents,
      [defaultAgent]: {
        ...defaultAgentConfig,
        model: defaultAgentConfig.model ?? legacyAgent.model ?? '',
        thinking: defaultAgentConfig.thinking ?? legacyAgent.thinking ?? 'medium',
      },
    },
  }
  delete normalized.agent
  return normalized
}

function withAgentCompatibility(config: JsonRecord): JsonRecord {
  const agents = isRecord(config.agents) ? config.agents : {}
  const defaultAgent = typeof agents.default === 'string' ? agents.default : 'codex'
  const agentConfig = isRecord(agents[defaultAgent]) ? agents[defaultAgent] : {}

  return {
    ...config,
    agent: {
      kind: defaultAgent,
      model: typeof agentConfig.model === 'string' ? agentConfig.model : '',
      models: configuredAgentModels(agentConfig),
      thinking: typeof agentConfig.thinking === 'string' ? agentConfig.thinking : 'medium',
    },
  }
}

function configuredAgentModels(agentConfig: JsonRecord) {
  const models = Array.isArray(agentConfig.models)
    ? agentConfig.models.filter((value): value is string => typeof value === 'string' && value.length > 0)
    : []
  const model = typeof agentConfig.model === 'string' && agentConfig.model.length > 0 ? agentConfig.model : ''
  return model && !models.includes(model) ? [model, ...models] : models
}

function normalizeDotagentsConfig(raw: JsonRecord, exists: boolean): DotagentsConfig {
  return {
    version: typeof raw.version === 'number' ? raw.version : 1,
    gitignore: typeof raw.gitignore === 'boolean' ? raw.gitignore : false,
    agents: normalizeStringArray(raw.agents, ['codex']),
    skills: normalizeDotagentsSkills(raw.skills),
    mcp: normalizeDotagentsMcp(raw.mcp),
    hooks: normalizeDotagentsHooks(raw.hooks),
    exists,
  }
}

function stripDotagentsRuntimeFields(config: DotagentsConfig) {
  const { exists: _exists, ...persisted } = config
  return persisted
}

function prepareDotagentsForWrite(config: DotagentsConfig) {
  const persisted = stripDotagentsRuntimeFields(config)
  return {
    ...persisted,
    skills: persisted.skills
      .map((skill) => ({
        name: skill.name.trim(),
        source: skill.source.trim(),
      }))
      .filter((skill) => skill.name && skill.source),
    mcp: persisted.mcp
      .map((server) => {
        const name = server.name.trim()
        const command = server.command?.trim()
        const url = server.url?.trim()
        const headers = Object.fromEntries(
          Object.entries(server.headers).filter(([key, value]) => key.trim() && value.trim()),
        )
        return {
          name,
          ...(command ? { command, args: server.args, env: server.env } : {}),
          ...(url && !command ? { url, ...(Object.keys(headers).length ? { headers } : {}) } : {}),
        }
      })
      .filter((server) => server.name && ('command' in server || 'url' in server)),
    hooks: persisted.hooks
      .map((hook) => ({
        event: hook.event.trim(),
        ...(hook.matcher?.trim() ? { matcher: hook.matcher.trim() } : {}),
        command: hook.command.trim(),
      }))
      .filter((hook) => hook.event && hook.command),
  }
}

function normalizeDotagentsSkills(value: unknown): DotagentsSkill[] {
  if (!Array.isArray(value)) return []
  return value
    .filter(isRecord)
    .map((skill) => ({
      name: typeof skill.name === 'string' ? skill.name : '',
      source: typeof skill.source === 'string' ? skill.source : '',
    }))
    .filter((skill) => skill.name || skill.source)
}

function normalizeDotagentsMcp(value: unknown): DotagentsMcp[] {
  if (!Array.isArray(value)) return []
  return value
    .filter(isRecord)
    .map((server) => ({
      name: typeof server.name === 'string' ? server.name : '',
      command: typeof server.command === 'string' ? server.command : undefined,
      args: normalizeStringArray(server.args),
      env: normalizeStringArray(server.env),
      url: typeof server.url === 'string' ? server.url : undefined,
      headers: isRecord(server.headers) ? stringifyRecord(server.headers) : {},
    }))
    .filter((server) => server.name || server.command || server.url)
}

function normalizeIssueRuntimeState(issueId: string, value: unknown): IssueRuntimeState | null {
  if (!isRecord(value)) return null
  return {
    issueId,
    claimed: value.claimed === true,
    phase: isOrchestratorPhase(value.phase) ? value.phase : 'idle',
    attempt: readNonNegativeNumber(value.attempt, 0),
    nextRetryAt: typeof value.nextRetryAt === 'string' ? value.nextRetryAt : null,
    lastError: typeof value.lastError === 'string' ? value.lastError : null,
    sessionId: typeof value.sessionId === 'string' ? value.sessionId : null,
    threadId: typeof value.threadId === 'string' ? value.threadId : null,
    turnId: typeof value.turnId === 'string' ? value.turnId : null,
    tokenUsage: normalizeTokenUsage(value.tokenUsage),
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : new Date().toISOString(),
  }
}

function normalizeTokenUsage(value: unknown) {
  if (!isRecord(value)) return null
  return {
    inputTokens: readNonNegativeNumber(value.inputTokens, 0),
    outputTokens: readNonNegativeNumber(value.outputTokens, 0),
    reasoningOutputTokens: readNonNegativeNumber(value.reasoningOutputTokens, 0),
    cachedInputTokens: readNonNegativeNumber(value.cachedInputTokens, 0),
    totalTokens: readNonNegativeNumber(value.totalTokens, 0),
  }
}

function readPositiveNumber(value: unknown, fallback: number) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback
}

function readNonNegativeNumber(value: unknown, fallback: number) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : fallback
}

function isOrchestratorPhase(value: unknown): value is IssueRuntimeState['phase'] {
  return typeof value === 'string' && ['idle', 'queued', 'running', 'retry_waiting', 'completed', 'failed', 'cancelled'].includes(value)
}

function normalizeDotagentsHooks(value: unknown): DotagentsHook[] {
  if (!Array.isArray(value)) return []
  return value
    .filter(isRecord)
    .map((hook) => ({
      event: typeof hook.event === 'string' ? hook.event : 'PreToolUse',
      matcher: typeof hook.matcher === 'string' ? hook.matcher : undefined,
      command: typeof hook.command === 'string' ? hook.command : '',
    }))
    .filter((hook) => hook.event || hook.command)
}

function normalizeStringArray(value: unknown, fallback: string[] = []) {
  if (!Array.isArray(value)) return fallback
  const values = value.filter((item): item is string => typeof item === 'string' && item.length > 0)
  return values.length > 0 ? [...new Set(values)] : fallback
}

function readProjectRefs(value: unknown): Array<{ path: string }> {
  if (!Array.isArray(value)) return []
  return value
    .filter(isRecord)
    .map((project) => ({ path: typeof project.path === 'string' ? project.path : '' }))
    .filter((project) => project.path.length > 0)
}

function parseOriginUrl(gitConfig: string) {
  const originSection = gitConfig.match(/\[remote "origin"\]([\s\S]*?)(?:\n\[|$)/)
  const urlLine = originSection?.[1]?.match(/^\s*url\s*=\s*(.+)\s*$/m)
  return urlLine?.[1] ?? ''
}

function projectSlug(projectPath: string, folderName: string) {
  const prefix = slugify(folderName)
  const hash = stableId(projectPath).slice(0, 10)
  return `${prefix}-${hash}`
}

function slugify(value: string) {
  const slug = value
    .toLowerCase()
    .replace(/^@/, '')
    .replace(/\//g, '-')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

  return slug || 'project'
}

function didEnterTodo(previousStatus: string | undefined, nextStatus: string) {
  return statusKey(previousStatus ?? 'backlog') !== 'todo' && statusKey(nextStatus) === 'todo'
}

function statusKey(status: string) {
  return status.trim().toLowerCase().replace(/[\s-]+/g, '_')
}

function normalizeProjectStatus(status: unknown) {
  const normalized = typeof status === 'string' ? statusKey(status) : ''
  return ['backlog', 'todo', 'in_progress', 'done'].includes(normalized) ? normalized : 'backlog'
}

function isTheme(value: unknown): value is ThemePreference {
  return value === 'system' || value === 'light' || value === 'dark'
}

function stringifyRecord(record: JsonRecord) {
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, String(value)]))
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isMissingFile(error: unknown) {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}
